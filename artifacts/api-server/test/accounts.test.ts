import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup } from "./helpers";

const { mock, dir } = await setup({ account: false });

// Two pre-authenticated accounts, matching the shape xbox-auth.ts writes itself.
fs.writeFileSync(`${dir}/.xbox-auth.json`, JSON.stringify({
  version: 2,
  activeAccountId: "acct-a",
  accounts: [
    { id: "acct-a", xuid: "2533274900000001", gamertag: "AccountA", maskedEmail: "aa•••@e•••.com", addedAt: 1, msRefreshToken: "rt-a" },
    { id: "acct-b", xuid: "2533274900000002", gamertag: "AccountB", maskedEmail: "bb•••@e•••.com", addedAt: 2, msRefreshToken: "rt-b" },
  ],
}));

const auth = await import("../src/lib/xbox-auth");

after(() => { mock.server.close(); });

test("getAccountInfoList reports both accounts, display-safe, with the right one active", () => {
  const list = auth.getAccountInfoList();
  assert.equal(list.length, 2);
  const a = list.find((x) => x.id === "acct-a")!;
  const b = list.find((x) => x.id === "acct-b")!;
  assert.equal(a.isActive, true);
  assert.equal(b.isActive, false);
  assert.equal(a.gamertag, "AccountA");
  assert.equal(b.gamertag, "AccountB");
  assert.equal(a.maskedEmail, "aa•••@e•••.com");
  // No refresh token or raw email anywhere in the serialized list.
  const json = JSON.stringify(list);
  for (const secret of ["rt-a", "rt-b", "@example"]) assert.ok(!json.includes(secret));
});

test("setActiveAccount switches which account claims run as, and persists it", async () => {
  const ok = auth.setActiveAccount("acct-b");
  assert.equal(ok, true);
  assert.equal(auth.getActiveAccountId(), "acct-b");
  assert.equal(auth.getAccountInfoList().find((a) => a.id === "acct-b")?.isActive, true);

  // The mock Xbox server has one shared identity regardless of which
  // refresh token is used, so accountId (tracked purely in-process) is what
  // actually proves the claim context now targets the other account.
  const ctx = await auth.getClaimContext();
  assert.ok(ctx.ok);
  if (ctx.ok) assert.equal(ctx.accountId, "acct-b");

  const onDisk = JSON.parse(fs.readFileSync(".xbox-auth.json", "utf8")) as { activeAccountId: string };
  assert.equal(onDisk.activeAccountId, "acct-b");

  auth.setActiveAccount("acct-a"); // reset for the next tests
});

test("setActiveAccount on an unknown id is refused and leaves the active account unchanged", () => {
  const before = auth.getActiveAccountId();
  const ok = auth.setActiveAccount("does-not-exist");
  assert.equal(ok, false);
  assert.equal(auth.getActiveAccountId(), before);
});

test("removing the active account falls back to another remaining account", () => {
  assert.equal(auth.getActiveAccountId(), "acct-a");
  const ok = auth.removeAccount("acct-a");
  assert.equal(ok, true);
  assert.equal(auth.getActiveAccountId(), "acct-b", "the only remaining account becomes active");
  assert.deepEqual(auth.getAccountInfoList().map((a) => a.id), ["acct-b"]);
});

test("removing the last account leaves none active, and the removal persists", () => {
  const ok = auth.removeAccount("acct-b");
  assert.equal(ok, true);
  assert.equal(auth.getActiveAccountId(), null);
  assert.deepEqual(auth.getAccountInfoList(), []);

  const onDisk = JSON.parse(fs.readFileSync(".xbox-auth.json", "utf8")) as { accounts: unknown[]; activeAccountId: string | null };
  assert.deepEqual(onDisk.accounts, []);
  assert.equal(onDisk.activeAccountId, null);
});

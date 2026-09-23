import { test } from "node:test";
import assert from "node:assert/strict";

const audit = await import("../src/lib/audit");

test("logAudit records an entry and listAudit returns it in order", () => {
  const before = audit.listAudit(0, 10_000).length;
  audit.logAudit("ACCOUNT_CONNECTED", { accountId: "acct-x" });
  audit.logAudit("CLAIM_CONFIRMED", { accountId: "acct-x", gamertag: "Test" });
  const all = audit.listAudit(0, 10_000);
  assert.equal(all.length, before + 2);
  assert.equal(all[all.length - 2]!.event, "ACCOUNT_CONNECTED");
  assert.equal(all[all.length - 1]!.event, "CLAIM_CONFIRMED");
});

test("listAudit(afterId) only returns entries newer than afterId", () => {
  audit.logAudit("ACCOUNT_DISCONNECTED", { accountId: "acct-y" });
  const all = audit.listAudit(0, 10_000);
  const cursor = all[all.length - 1]!.id;
  audit.logAudit("ACCOUNT_AUTH_STARTED", {});
  const after = audit.listAudit(cursor);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.event, "ACCOUNT_AUTH_STARTED");
});

test("a meta key that looks like it could hold a credential is stripped, never logged", () => {
  audit.logAudit("ACCOUNT_AUTH_FAILED", {
    accountId: "acct-z",
    refreshToken: "should-never-appear",
    password: "should-never-appear",
    Authorization: "should-never-appear",
    authCookie: "should-never-appear",
    clientSecret: "should-never-appear",
    reason: "this is fine to keep",
  });
  const all = audit.listAudit(0, 10_000);
  const entry = all[all.length - 1]!;
  assert.equal(entry.event, "ACCOUNT_AUTH_FAILED");
  assert.deepEqual(Object.keys(entry.meta).sort(), ["accountId", "reason"]);
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes("should-never-appear"));
});

test("the log is bounded and drops the oldest entries once full", () => {
  const cap = 500;
  for (let i = 0; i < cap + 20; i++) audit.logAudit("CLAIM_STARTED", { i });
  const all = audit.listAudit(0, 10_000);
  assert.ok(all.length <= cap, `expected at most ${cap} entries, got ${all.length}`);
});

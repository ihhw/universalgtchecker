import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup, until } from "./helpers";

const { mock, dir } = await setup({ account: false });

fs.writeFileSync(`${dir}/.xbox-auth.json`, JSON.stringify({
  version: 2,
  activeAccountId: "acct-a",
  accounts: [
    { id: "acct-a", xuid: null, gamertag: null, maskedEmail: "aa•••@e•••.com", addedAt: 1, msRefreshToken: "rt-a" },
    { id: "acct-b", xuid: null, gamertag: null, maskedEmail: "bb•••@e•••.com", addedAt: 2, msRefreshToken: "rt-b" },
  ],
}));

const auth = await import("../src/lib/xbox-auth");
const claim = await import("../src/lib/xbox-claim");

after(() => { mock.server.close(); });

beforeEach(() => {
  mock.state.taken = new Set(["TAKENTAG"]);
  mock.state.sticky = {};
  mock.state.queues = {};
  mock.state.reservations.clear();
  mock.state.gamertag = "OldTag";
  mock.state.log.length = 0;
});

test("explicit accountId claims with that account, regardless of which one is active", async () => {
  // acct-b is not active, but an explicit accountId must still be honoured.
  const r = await claim.claimGamertag("ExplicitTag", { source: "manual", accountId: "acct-b" });
  assert.equal(r.state, "claimed");
  assert.equal(r.accountId, "acct-b");
});

test("automatic selection uses the active account when it's usable", async () => {
  const r = await claim.claimGamertag("AutoTag", { source: "manual" }); // no accountId => automatic
  assert.equal(r.state, "claimed");
  assert.equal(r.accountId, "acct-a", "acct-a is active and should be preferred");
});

test("two different accounts can claim two different gamertags at the same time (per-account, not global, contention)", async () => {
  const [r1, r2] = await Promise.all([
    claim.claimGamertag("ConcurrentOne", { source: "manual", accountId: "acct-a" }),
    claim.claimGamertag("ConcurrentTwo", { source: "manual", accountId: "acct-b" }),
  ]);
  assert.equal(r1.state, "claimed", r1.reason ?? "");
  assert.equal(r2.state, "claimed", r2.reason ?? "");
  assert.notEqual(r1.errorCode, "claim_in_progress");
  assert.notEqual(r2.errorCode, "claim_in_progress");
});

test("a second concurrent claim on the SAME account is refused as claim_in_progress, not queued", async () => {
  mock.state.latencyMs = { change: 300 };
  const first = claim.claimGamertag("SlowTag", { source: "manual", accountId: "acct-a" });
  await until(() => claim.claimInProgress("acct-a") !== null, 2_000);
  const second = await claim.claimGamertag("OtherTag", { source: "manual", accountId: "acct-a" });
  assert.equal(second.state, "claim_failed");
  assert.equal(second.errorCode, "claim_in_progress");
  const r1 = await first;
  assert.equal(r1.state, "claimed");
  mock.state.latencyMs = {};
});

test("automatic selection skips a busy account and picks the other free one", async () => {
  mock.state.latencyMs = { change: 300 };
  const busyClaim = claim.claimGamertag("HoldTag", { source: "manual", accountId: "acct-a" });
  await until(() => claim.claimInProgress("acct-a") !== null, 2_000);

  const auto = await claim.claimGamertag("PickedTag", { source: "manual" }); // automatic, acct-a is busy
  assert.equal(auto.state, "claimed");
  assert.equal(auto.accountId, "acct-b", "acct-a is busy, so automatic must pick acct-b");

  await busyClaim;
  mock.state.latencyMs = {};
});

test("selecting a nonexistent account id fails immediately, before any Xbox request", async () => {
  const before = mock.state.log.length;
  const r = await claim.claimGamertag("NeverSent", { source: "manual", accountId: "does-not-exist" });
  assert.equal(r.state, "auth_error");
  assert.match(r.reason ?? "", /not found/i);
  assert.equal(mock.state.log.length, before, "no request should reach Xbox for an unknown account");
});

test("when every account is busy, automatic selection fails closed with a clear reason (not a silent pick)", async () => {
  mock.state.latencyMs = { change: 300 };
  const c1 = claim.claimGamertag("BusyOne", { source: "manual", accountId: "acct-a" });
  const c2 = claim.claimGamertag("BusyTwo", { source: "manual", accountId: "acct-b" });
  await until(() => claim.claimInProgress("acct-a") !== null && claim.claimInProgress("acct-b") !== null, 2_000);

  const r = await claim.claimGamertag("Overflow", { source: "manual" });
  assert.equal(r.state, "claim_failed");
  assert.equal(r.errorCode, "claim_in_progress");

  await Promise.all([c1, c2]);
  mock.state.latencyMs = {};
});

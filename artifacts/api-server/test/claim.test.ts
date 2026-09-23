import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setup, control, captureWebhooks, WEBHOOK_URL } from "./helpers";

const { mock } = await setup();
const webhooks = captureWebhooks();
const claim = await import("../src/lib/xbox-claim");
const store = await import("../src/lib/webhook-store");
const auth = await import("../src/lib/xbox-auth");

after(() => { mock.server.close(); });

beforeEach(async () => {
  // Fresh Xbox-side state, but the app keeps its (valid) tokens.
  const keep = { gamertag: "OldTag" };
  mock.state.queues = {};
  mock.state.sticky = {};
  mock.state.taken = new Set(["TAKENTAG"]);
  mock.state.reservations.clear();
  mock.state.gamertag = keep.gamertag;
  mock.state.log.length = 0;
  webhooks.length = 0;
});

const calls = (ep: string) => mock.state.log.filter((l) => l.endpoint === ep);

test("200: reserve + change, Xbox names the exact tag → CLAIMED (change_response)", async () => {
  const r = await claim.claimGamertag("NewTag", { source: "manual" });
  assert.equal(r.state, "claimed");
  assert.equal(r.confirmedBy, "change_response");
  assert.equal(r.assignedGamertag, "NewTag");
  assert.equal(r.httpStatus, 200);
  // Correct requests went out:
  const [res] = calls("reserve");
  assert.match(String(res!.auth), /^XBL3\.0 x=uhs-1;xsts\|http:\/\/xboxlive\.com\|/, "claim uses the xboxlive.com XSTS token");
  assert.deepEqual(res!.body, { classicGamertag: "NewTag", reservationId: "2533274900000001", targetGamertagFields: "classicGamertag" });
  const [chg] = calls("change");
  assert.equal(chg!.method, "POST");
  assert.equal(chg!.path, "/accounts.xboxlive.com/users/current/profile/gamertag");
  assert.deepEqual(chg!.body, { gamertag: "NewTag", previewOnly: false });
  assert.ok(r.latency.totalMs !== null && r.latency.reserveMs !== null && r.latency.changeMs !== null);
  assert.equal(mock.state.gamertag, "NewTag");
});

test("201/202/204 with no body → confirmed only via fresh XSTS identity", async () => {
  // 202 + Xbox really changed it (mock state) → claimed via identity.
  await control(mock.url, { queues: { change: [{ status: 202, body: "" }] } });
  const p = claim.claimGamertag("AsyncTag", { source: "manual" });
  // Xbox applies the change while answering 202 with no body:
  setTimeout(() => { mock.state.gamertag = "AsyncTag"; }, 0);
  const r = await p;
  assert.equal(r.state, "claimed");
  assert.equal(r.confirmedBy, "xsts_identity");

  // 204 but the account's gamertag did NOT change → UNKNOWN, never CLAIMED.
  mock.state.gamertag = "OldTag";
  await control(mock.url, { queues: { change: [{ status: 204 }] } });
  const r2 = await claim.claimGamertag("Unconfirmed", { source: "manual" });
  assert.equal(r2.state, "unknown");
  assert.equal(r2.errorCode, "unconfirmed");
  assert.match(r2.reason ?? "", /did not confirm/);

  // 201 with a body naming the tag → claimed from the response.
  await control(mock.url, { queues: { change: [{ status: 201, body: { classicGamertag: "Created", gamertagSuffix: "" } }] } });
  const r3 = await claim.claimGamertag("Created", { source: "manual" });
  assert.equal(r3.state, "claimed");
  assert.equal(r3.confirmedBy, "change_response");
});

test("200 but Xbox names a different/suffixed tag → never CLAIMED", async () => {
  await control(mock.url, { queues: { change: [{ status: 200, body: { classicGamertag: "Wanted", gamertagSuffix: "1234" } }] } });
  const r = await claim.claimGamertag("Wanted", { source: "manual" });
  assert.equal(r.state, "unknown");
  assert.equal(r.errorCode, "suffix_assigned");
});

test("reserve 200 with a suffix → CLAIM FAILED before any change request", async () => {
  await control(mock.url, { queues: { reserve: [{ status: 200, body: { classicGamertag: "Sfx", gamertagSuffix: "42" } }] } });
  const r = await claim.claimGamertag("Sfx", { source: "manual" });
  assert.equal(r.state, "claim_failed");
  assert.equal(r.errorCode, "suffix_required");
  assert.equal(calls("change").length, 0);
});

test("409 taken at reserve → CLAIM FAILED (taken), no change sent", async () => {
  const r = await claim.claimGamertag("TakenTag", { source: "manual" });
  assert.equal(r.state, "claim_failed");
  assert.equal(r.errorCode, "taken");
  assert.equal(r.httpStatus, 409);
  assert.match(r.reason ?? "", /Gamertag is not available/, "Xbox's own description is surfaced");
  assert.equal(calls("change").length, 0);
});

test("400 / 404 at reserve → CLAIM FAILED with the real reason", async () => {
  await control(mock.url, { queues: { reserve: [{ status: 400, body: { description: "Offensive" } }, { status: 404, body: {} }] } });
  const r1 = await claim.claimGamertag("BadWord", { source: "manual" });
  assert.equal(r1.state, "claim_failed");
  assert.equal(r1.errorCode, "rejected");
  assert.match(r1.reason ?? "", /Offensive/);
  const r2 = await claim.claimGamertag("NoRoute", { source: "manual" });
  assert.equal(r2.errorCode, "not_found");
  assert.equal(r2.httpStatus, 404);
});

test("401 at reserve → re-issue XSTS and retry once; persistent 401 → AUTH ERROR", async () => {
  await control(mock.url, { queues: { reserve: [{ status: 401, body: {} }] } });
  const ok = await claim.claimGamertag("RetryOk", { source: "manual" });
  assert.equal(ok.state, "claimed", "one 401 then success after token re-issue");
  assert.equal(calls("reserve").length, 2);

  await control(mock.url, { queues: { reserve: [{ status: 401, body: {} }, { status: 401, body: {} }] } });
  const r = await claim.claimGamertag("Denied", { source: "manual" });
  assert.equal(r.state, "auth_error");
  assert.equal(r.errorCode, "auth_failed");
});

test("403 at reserve → AUTH ERROR; 403 at change → CLAIM FAILED (not allowed)", async () => {
  await control(mock.url, { queues: { reserve: [{ status: 403, body: { description: "Forbidden" } }] } });
  const r1 = await claim.claimGamertag("Forbid", { source: "manual" });
  assert.equal(r1.state, "auth_error");
  await control(mock.url, { queues: { change: [{ status: 403, body: { description: "No free gamertag change" } }] } });
  const r2 = await claim.claimGamertag("PaidOnly", { source: "manual" });
  assert.equal(r2.state, "claim_failed");
  assert.equal(r2.errorCode, "not_allowed");
  assert.match(r2.reason ?? "", /No free gamertag change/);
});

test("429 → RATE LIMITED with Retry-After honoured (reserve and change)", async () => {
  await control(mock.url, { queues: { reserve: [{ status: 429, body: {}, headers: { "Retry-After": "7" } }] } });
  const r1 = await claim.claimGamertag("Busy", { source: "manual" });
  assert.equal(r1.state, "rate_limited");
  assert.equal(r1.retryAfterMs, 7_000);
  await control(mock.url, { queues: { change: [{ status: 429, body: {} }] } });
  const r2 = await claim.claimGamertag("Busy2", { source: "manual" });
  assert.equal(r2.state, "rate_limited");
  assert.equal(r2.step, "change");
});

for (const code of [500, 502, 503, 504]) {
  test(`${code} at reserve → CLAIM FAILED (nothing changed); ${code} at change → identity decides`, async () => {
    await control(mock.url, { queues: { reserve: [{ status: code, body: {} }] } });
    const r1 = await claim.claimGamertag("Srv", { source: "manual" });
    assert.equal(r1.state, "claim_failed");
    assert.equal(r1.errorCode, "xbox_error");
    assert.equal(r1.httpStatus, code);

    await control(mock.url, { queues: { change: [{ status: code, body: {} }] } });
    const r2 = await claim.claimGamertag("Srv2", { source: "manual" });
    assert.equal(r2.state, "claim_failed", "account still reports the old gamertag");
    assert.equal(r2.assignedGamertag, "OldTag");
  });
}

test("5xx at change but Xbox DID apply it → CLAIMED via identity (never lost)", async () => {
  await control(mock.url, { queues: { change: [{ status: 503, body: {} }] } });
  const p = claim.claimGamertag("Applied", { source: "manual" });
  setTimeout(() => { mock.state.gamertag = "Applied"; }, 0);
  const r = await p;
  assert.equal(r.state, "claimed");
  assert.equal(r.confirmedBy, "xsts_identity");
});

test("405 at change (wrong HTTP method) → UNKNOWN, never CLAIMED, Allow header surfaced verbatim", async () => {
  await control(mock.url, {
    queues: { change: [{ status: 405, body: { message: "Method Not Allowed" }, headers: { Allow: "PUT, PATCH" } }] },
  });
  const r = await claim.claimGamertag("MethodTag", { source: "manual" });
  assert.equal(r.state, "unknown");
  assert.equal(r.httpStatus, 405);
  assert.match(r.reason ?? "", /405/);
  assert.match(r.reason ?? "", /it accepts: PUT, PATCH/);
  assert.notEqual(mock.state.gamertag, "MethodTag", "nothing was actually changed");
});

test("timeout at reserve → NETWORK ERROR; timeout at change → UNKNOWN", async () => {
  await control(mock.url, { queues: { reserve: [{ delayMs: 2_500, status: 200, body: {} }] } });
  const r1 = await claim.claimGamertag("SlowRes", { source: "manual" });
  assert.equal(r1.state, "network_error");
  assert.equal(r1.errorCode, "timeout");

  await control(mock.url, { queues: { change: [{ delayMs: 2_500, status: 200, body: {} }] } });
  const r2 = await claim.claimGamertag("SlowChg", { source: "manual" });
  assert.equal(r2.state, "unknown");
  assert.equal(r2.errorCode, "timeout");
});

test("connection dropped → NETWORK ERROR (reserve and change)", async () => {
  await control(mock.url, { queues: { reserve: [{ drop: true }] } });
  const r1 = await claim.claimGamertag("Drop1", { source: "manual" });
  assert.equal(r1.state, "network_error");
  assert.equal(r1.step, "reserve");
  await control(mock.url, { queues: { change: [{ drop: true }] } });
  const r2 = await claim.claimGamertag("Drop2", { source: "manual" });
  assert.equal(r2.state, "network_error");
  assert.equal(r2.step, "change");
});

test("only one claim at a time: a concurrent claim is refused, not queued", async () => {
  await control(mock.url, { queues: { reserve: [{ delayMs: 300 }] } });
  const [a, b] = await Promise.all([
    claim.claimGamertag("FirstOne", { source: "manual" }),
    claim.claimGamertag("SecondOne", { source: "manual" }),
  ]);
  assert.equal(a.state, "claimed");
  assert.equal(b.state, "claim_failed");
  assert.equal(b.errorCode, "claim_in_progress");
  assert.equal(calls("change").length, 1);
});

test("invalid gamertag never reaches Xbox", async () => {
  const r = await claim.claimGamertag("1bad", { source: "manual" });
  assert.equal(r.errorCode, "invalid_gamertag");
  assert.equal(mock.state.log.length, 0);
});

test("webhook: CLAIMED embed only for confirmed claims; failures carry Xbox's reason", async () => {
  store.saveWebhook({ url: WEBHOOK_URL, enabled: true });
  const ok = await claim.claimGamertag("HookTag", { source: "sniper" });
  await claim.notifyClaimWebhook(ok, "Xbox Sniper");
  const bad = await claim.claimGamertag("TakenTag", { source: "sniper" });
  await claim.notifyClaimWebhook(bad, "Xbox Sniper");
  assert.equal(webhooks.length, 2);
  const [s, f] = webhooks.map((w) => w.body.embeds[0]);
  assert.equal(s.title, "Xbox Sniper");
  assert.deepEqual(s.fields.slice(0, 2).map((x: any) => x.value), ["HookTag", "CLAIMED"]);
  assert.match(s.fields[2].value, /^\d+ms$/);
  assert.deepEqual(f.fields.slice(0, 2).map((x: any) => x.value), ["TakenTag", "CLAIM FAILED"]);
  assert.match(f.fields[2].value, /taken or reserved/);
  assert.ok(!JSON.stringify(webhooks).includes("xsts|"), "no token in webhook payload");
  // A record still in flight is never announced.
  const inflight = { ...ok, state: "claiming" as const };
  assert.equal(await claim.notifyClaimWebhook(inflight, "Xbox Sniper"), false);
  store.clearWebhook();
});

test("no account → AUTH ERROR with the real reason", async () => {
  auth.logoutAllAccounts();
  const r = await claim.claimGamertag("NoAcct", { source: "manual" });
  assert.equal(r.state, "auth_error");
  assert.match(r.reason ?? "", /No Xbox account connected/);
});

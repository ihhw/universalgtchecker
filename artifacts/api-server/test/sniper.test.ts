import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup, control, captureWebhooks, until, WEBHOOK_URL } from "./helpers";

const { mock } = await setup();
const webhooks = captureWebhooks();
const sniper = await import("../src/lib/xbox-sniper");
const store = await import("../src/lib/webhook-store");

after(() => { sniper.stopSniper("test teardown"); mock.server.close(); });

beforeEach(() => {
  sniper.stopSniper("reset");
  mock.state.queues = {};
  mock.state.sticky = {};
  mock.state.taken = new Set(["TAKENTAG", "TARGETTAG"]);
  mock.state.reservations.clear();
  mock.state.gamertag = "OldTag";
  mock.state.log.length = 0;
  webhooks.length = 0;
});

const snap = () => sniper.getSniperSnapshot();
const msgs = () => snap().events.map((e) => e.message);
const calls = (ep: string) => mock.state.log.filter((l) => l.endpoint === ep);

test("config validation: bad tag, content-filtered tag, interval bounds", async () => {
  const r1 = await sniper.startSniper({ target: "1abc" });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.error, /start with a letter/);
  const r2 = await sniper.startSniper({ target: "ValidTag", intervalMs: 100 });
  assert.equal(r2.ok, false);
  const r3 = await sniper.startSniper({ target: "FUCKER" });
  assert.equal(r3.ok, false);
});

test("watching a TAKEN tag: real checks, no claims, fixed interval", async () => {
  const r = await sniper.startSniper({ target: "TargetTag", intervalMs: 500, doubleCheck: true, autoClaim: true, notifications: true });
  assert.deepEqual(r, { ok: true });
  assert.equal(snap().state, "watching");
  await until(() => snap().checks >= 3, 5_000);
  sniper.stopSniper();
  const s = snap();
  assert.equal(s.state, "stopped");
  assert.equal(s.availability, "taken");
  assert.equal(s.claimAttempts, 0);
  assert.equal(calls("reserve").length, 0);
  assert.ok(msgs().some((m) => m === "Checking TargetTag"));
  assert.ok(msgs().some((m) => /^TargetTag — TAKEN \(CDN HTTP 200, \d+ms\)$/.test(m)));
  // Interval respected: ≥ ~500 ms between check starts.
  const ts = calls("cdn").map((c) => c.at);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i]! - ts[i - 1]! >= 450, `gap ${ts[i]! - ts[i - 1]!}ms`);
  const n = calls("cdn").length;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(calls("cdn").length, n, "no checks after STOP");
});

test("TAKEN → AVAILABLE (Double Check approved) → CLAIMING → CLAIMED; webhook; stops", async () => {
  store.saveWebhook({ url: WEBHOOK_URL, enabled: true });
  await sniper.startSniper({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().checks >= 2, 5_000);
  mock.state.taken.delete("TARGETTAG"); // the tag is released
  await until(() => snap().state === "claimed", 5_000);
  const s = snap();
  assert.equal(s.claim, "claimed");
  assert.equal(s.lastClaim?.confirmedBy, "change_response");
  assert.equal(mock.state.gamertag, "TargetTag");
  assert.equal(s.claimAttempts, 1);
  for (const k of ["availabilityMs", "claimMs", "reactionMs", "totalMs"] as const) {
    assert.equal(typeof s.latency[k], "number", `${k} measured`);
  }
  const m = msgs();
  const iAvail = m.findIndex((x) => /TargetTag — AVAILABLE \(CDN HTTP 404 · Double Check approved/.test(x));
  const iSent = m.indexOf("Claim request sent for TargetTag");
  const iOk = m.findIndex((x) => x.startsWith("Claim confirmed by Xbox"));
  assert.ok(iAvail >= 0 && iSent > iAvail && iOk > iSent, m.join("\n"));
  // Double Check ran before the claim; claim = reserve then change.
  const order = mock.state.log.map((l) => l.endpoint).filter((e) => ["policy", "reserve", "change"].includes(e));
  assert.deepEqual(order, ["policy", "reserve", "change"]);
  await until(() => webhooks.length === 1, 2_000);
  const f = webhooks[0]!.body.embeds[0].fields;
  assert.equal(f[1].value, "CLAIMED");
  const n = calls("cdn").length;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(calls("cdn").length, n, "sniper stopped after the claim");
  store.clearWebhook();
});

test("Double Check says taken (409) → not available, no claim (Double Check preserved)", async () => {
  mock.state.taken.delete("TARGETTAG");
  await control(mock.url, { sticky: { policy: { status: 409, body: {} } } });
  await sniper.startSniper({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().checks >= 2, 5_000);
  sniper.stopSniper();
  assert.equal(snap().availability, "taken");
  assert.equal(calls("reserve").length, 0);
  assert.ok(msgs().some((m) => /Double Check says taken \(HTTP 409\)/.test(m)));
});

test("claim fails (taken by someone else) → CLAIM FAILED, keeps watching with a claim cooldown", async () => {
  mock.state.taken.delete("TARGETTAG");
  await control(mock.url, { sticky: { reserve: { status: 409, body: { description: "Gamertag is not available" } } } });
  await sniper.startSniper({ target: "TargetTag", intervalMs: 500, notifications: true });
  store.saveWebhook({ url: WEBHOOK_URL, enabled: true });
  await until(() => snap().claim === "claim_failed", 5_000);
  await until(() => snap().checks >= 4, 5_000);
  const s = snap();
  assert.equal(s.state, "watching");
  assert.equal(s.claimAttempts, 1, "cooldown prevents hammering claims every check");
  assert.ok(msgs().some((m) => /^CLAIM FAILED: Xbox reports "TargetTag" is taken or reserved by someone else \(HTTP 409\)/.test(m)));
  assert.ok(msgs().some((m) => m.startsWith("Claim cooling down")));
  sniper.stopSniper();
  store.clearWebhook();
});

test("CDN 429 → RATE LIMITED, backs off per Retry-After, then resumes", async () => {
  await control(mock.url, { queues: { cdn: [{ status: 429, headers: { "Retry-After": "1" } }] } });
  await sniper.startSniper({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().checks >= 2, 6_000);
  const ts = calls("cdn").map((c) => c.at);
  assert.ok(ts[1]! - ts[0]! >= 950, `backoff honoured (${ts[1]! - ts[0]!}ms)`);
  assert.ok(msgs().some((m) => /RATE LIMITED — Xbox CDN returned HTTP 429; backing off/.test(m)));
  await until(() => snap().availability === "taken", 3_000);
  sniper.stopSniper();
});

test("network failure on a check → NETWORK ERROR logged, sniper keeps watching", async () => {
  await control(mock.url, { queues: { cdn: [{ drop: true }] } });
  await sniper.startSniper({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().checks >= 2 && snap().availability === "taken", 5_000);
  assert.ok(msgs().some((m) => /NETWORK ERROR \(CDN request failed \(network\)/.test(m)));
  assert.equal(snap().state, "watching");
  sniper.stopSniper();
});

test("claim auth error → sniper stops with the real reason", async () => {
  mock.state.taken.delete("TARGETTAG");
  await control(mock.url, { sticky: { reserve: { status: 403, body: { description: "Account restricted" } } } });
  await sniper.startSniper({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().state === "error", 5_000);
  assert.equal(snap().claim, "auth_error");
  assert.match(snap().stopReason ?? "", /Account restricted/);
});

test("Auto Claim OFF → reports AVAILABLE but never claims", async () => {
  mock.state.taken.delete("TARGETTAG");
  await sniper.startSniper({ target: "TargetTag", intervalMs: 500, autoClaim: false });
  await until(() => snap().availability === "available", 5_000);
  await until(() => snap().checks >= 2, 5_000);
  assert.equal(snap().claim, "disabled");
  assert.equal(calls("reserve").length, 0);
  sniper.stopSniper();
});

test("account not ready → start refused with the reason", async () => {
  await control(mock.url, { sticky: { xsts: { status: 401, body: { XErr: 2148916233 } } } });
  // Force the cached token to be re-verified.
  const auth = await import("../src/lib/xbox-auth");
  await auth.refreshActiveIdentity();
  const r = await sniper.startSniper({ target: "TargetTag" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /no Xbox profile/);
  mock.state.sticky = {};
  await auth.refreshActiveIdentity();
});

test("state is persisted to sniper.json (0600) without secrets", async () => {
  await sniper.startSniper({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().checks >= 1, 3_000);
  sniper.stopSniper();
  await until(() => fs.existsSync("sniper.json") && JSON.parse(fs.readFileSync("sniper.json", "utf8")).state === "stopped", 3_000);
  const raw = fs.readFileSync("sniper.json", "utf8");
  assert.equal(fs.statSync("sniper.json").mode & 0o777, 0o600);
  assert.ok(!/xsts\||rt-|ms-at-|xbl-user-/.test(raw));
  assert.equal(JSON.parse(raw).config.target, "TargetTag");
});

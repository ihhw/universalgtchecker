import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup, control, captureWebhooks, until, WEBHOOK_URL } from "./helpers";

const { mock } = await setup();
const webhooks = captureWebhooks();
const sniper = await import("../src/lib/xbox-sniper");
const store = await import("../src/lib/webhook-store");
const auth = await import("../src/lib/xbox-auth");

let currentId: string | null = null;

after(() => { if (currentId) sniper.stopSniper(currentId, "test teardown"); mock.server.close(); });

beforeEach(() => {
  for (const t of sniper.listSniperSnapshots()) sniper.removeSniper(t.id);
  currentId = null;
  mock.state.queues = {};
  mock.state.sticky = {};
  mock.state.taken = new Set(["TAKENTAG", "TARGETTAG"]);
  mock.state.reservations.clear();
  mock.state.gamertag = "OldTag";
  mock.state.log.length = 0;
  webhooks.length = 0;
  auth.clearAccountRateLimit("acct-1");
});

/** Starts a target and remembers its id for snap()/stop() in the rest of the test. */
async function start(input: Parameters<typeof sniper.startSniper>[0]) {
  const r = await sniper.startSniper(input);
  if (r.ok) currentId = r.id;
  return r;
}

const snap = () => sniper.getSniperSnapshot(currentId!)!;
const stop = () => sniper.stopSniper(currentId!);
const msgs = () => snap().events.map((e) => e.message);
const calls = (ep: string) => mock.state.log.filter((l) => l.endpoint === ep);

test("config validation: bad tag, content-filtered tag, interval bounds", async () => {
  const r1 = await sniper.startSniper({ target: "1abc" });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.error, /start with a letter/);
  const r2 = await sniper.startSniper({ target: "ValidTag", intervalMs: 100 });
  assert.equal(r2.ok, false);
  const r3 = await sniper.startSniper({ target: "NAZIFAN" });
  assert.equal(r3.ok, false);
});

test("watching a TAKEN tag: real checks, no claims, fixed interval", async () => {
  const r = await start({ target: "TargetTag", intervalMs: 500, doubleCheck: true, autoClaim: true, notifications: true });
  assert.equal(r.ok, true);
  assert.equal(snap().state, "watching");
  await until(() => snap().checks >= 3, 5_000);
  stop();
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
  await start({ target: "TargetTag", intervalMs: 500 });
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
  const iAvail = m.findIndex((x) => /TargetTag — AVAILABLE \(CDN HTTP 404 · reserve probe confirms no suffix needed/.test(x));
  const iSent = m.indexOf("Claim request sent for TargetTag");
  const iOk = m.findIndex((x) => x.startsWith("Claim confirmed by Xbox"));
  assert.ok(iAvail >= 0 && iSent > iAvail && iOk > iSent, m.join("\n"));
  // Double Check's reserve probe ran before the claim; claim = reserve then change.
  const order = mock.state.log.map((l) => l.endpoint).filter((e) => ["reserve", "change"].includes(e));
  assert.deepEqual(order, ["reserve", "reserve", "change"]);
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
  await control(mock.url, { sticky: { reserve: { status: 409, body: {} } } });
  await start({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().checks >= 2, 5_000);
  stop();
  assert.equal(snap().availability, "taken");
  assert.equal(calls("change").length, 0);
  assert.ok(msgs().some((m) => /reserve probe says taken \(HTTP 409\)/.test(m)));
});

test("claim fails (taken by someone else) → CLAIM FAILED, keeps watching with a claim cooldown", async () => {
  mock.state.taken.delete("TARGETTAG");
  // First reserve call is Double Check's own probe (must see it as available
  // so the sniper proceeds to claim); the claim's own reserve step then
  // hits the race — someone else grabbed it in between.
  await control(mock.url, { queues: { reserve: [
    { status: 200, body: { promptForClassicGamertag: true, classicTranslationLevel: "Full", modernGamertag: "TargetTag", uniqueModernGamertag: "TargetTag", modernGamertagSuffix: "0001", classicGamertag: "TargetTag", gamertag: "TargetTag" } },
    { status: 409, body: { description: "Gamertag is not available" } },
  ] } });
  await start({ target: "TargetTag", intervalMs: 500, notifications: true });
  store.saveWebhook({ url: WEBHOOK_URL, enabled: true });
  await until(() => snap().claim === "claim_failed", 5_000);
  await until(() => snap().checks >= 4, 5_000);
  const s = snap();
  assert.equal(s.state, "watching");
  assert.equal(s.claimAttempts, 1, "cooldown prevents hammering claims every check");
  assert.ok(msgs().some((m) => /^CLAIM FAILED: Xbox reports "TargetTag" is taken or reserved by someone else \(HTTP 409\)/.test(m)));
  assert.ok(msgs().some((m) => m.startsWith("Claim cooling down")));
  stop();
  store.clearWebhook();
});

test("CDN 429 → RATE LIMITED, backs off per Retry-After, then resumes", async () => {
  await control(mock.url, { queues: { cdn: [{ status: 429, headers: { "Retry-After": "1" } }] } });
  await start({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().checks >= 2, 6_000);
  const ts = calls("cdn").map((c) => c.at);
  assert.ok(ts[1]! - ts[0]! >= 950, `backoff honoured (${ts[1]! - ts[0]!}ms)`);
  assert.ok(msgs().some((m) => /RATE LIMITED — Xbox CDN returned HTTP 429; backing off/.test(m)));
  await until(() => snap().availability === "taken", 3_000);
  stop();
});

test("network failure on a check → NETWORK ERROR logged, sniper keeps watching", async () => {
  await control(mock.url, { queues: { cdn: [{ drop: true }] } });
  await start({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().checks >= 2 && snap().availability === "taken", 5_000);
  assert.ok(msgs().some((m) => /NETWORK ERROR \(CDN request failed \(network\)/.test(m)));
  assert.equal(snap().state, "watching");
  stop();
});

test("claim auth error → sniper stops with the real reason", async () => {
  mock.state.taken.delete("TARGETTAG");
  await control(mock.url, { sticky: { reserve: { status: 403, body: { description: "Account restricted" } } } });
  // Double Check off: this exercises the claim's own reserve auth failure,
  // not Double Check's probe (which would hit the same 403 first and stop
  // the sniper with a different, probe-specific message).
  await start({ target: "TargetTag", intervalMs: 500, doubleCheck: false });
  await until(() => snap().state === "error", 5_000);
  assert.equal(snap().claim, "auth_error");
  assert.match(snap().stopReason ?? "", /Account restricted/);
});

test("Auto Claim OFF → reports AVAILABLE but never claims", async () => {
  mock.state.taken.delete("TARGETTAG");
  await start({ target: "TargetTag", intervalMs: 500, autoClaim: false });
  await until(() => snap().availability === "available", 5_000);
  await until(() => snap().checks >= 2, 5_000);
  assert.equal(snap().claim, "disabled");
  // Double Check's own reserve probe still runs (it's how "available" gets
  // confirmed), but the claim engine's change step never fires.
  assert.equal(calls("change").length, 0);
  stop();
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
  await start({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().checks >= 1, 3_000);
  stop();
  await until(() => fs.existsSync("sniper.json") && JSON.parse(fs.readFileSync("sniper.json", "utf8")).targets?.[0]?.state === "stopped", 3_000);
  const raw = fs.readFileSync("sniper.json", "utf8");
  assert.equal(fs.statSync("sniper.json").mode & 0o777, 0o600);
  assert.ok(!/xsts\||rt-|ms-at-|xbl-user-/.test(raw));
  assert.equal(JSON.parse(raw).targets[0].config.target, "TargetTag");
});

// ─── Multi-target ───────────────────────────────────────────────────────────

test("two targets watch concurrently, independently, and can claim independently", async () => {
  mock.state.taken = new Set(["TAKENTAG"]); // TargetTag and SecondTag both start free
  const r1 = await sniper.startSniper({ target: "TargetTag", intervalMs: 500, doubleCheck: false });
  const r2 = await sniper.startSniper({ target: "SecondTag", intervalMs: 500, doubleCheck: false });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  if (!r1.ok || !r2.ok) return;

  await until(() => (sniper.getSniperSnapshot(r1.id)?.checks ?? 0) >= 1 && (sniper.getSniperSnapshot(r2.id)?.checks ?? 0) >= 1, 5_000);

  const targets = sniper.listSniperSnapshots();
  assert.equal(targets.length, 2);
  assert.deepEqual(new Set(targets.map((t) => t.config.target)), new Set(["TargetTag", "SecondTag"]));

  // Claiming one doesn't touch the other's state.
  await until(() => sniper.getSniperSnapshot(r1.id)?.state === "claimed", 5_000);
  assert.equal(sniper.getSniperSnapshot(r2.id)?.state, "watching");
  assert.equal(mock.state.gamertag, "TargetTag");

  sniper.stopSniper(r2.id);
  currentId = null;
});

test("starting a target already being watched is refused", async () => {
  mock.state.taken.delete("TARGETTAG");
  const r1 = await start({ target: "TargetTag", intervalMs: 500, autoClaim: false });
  assert.equal(r1.ok, true);
  const r2 = await sniper.startSniper({ target: "targettag", intervalMs: 500 }); // case-insensitive match
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.error, /Already watching/);
  stop();
});

test("removing a target stops it and drops it from the list", async () => {
  await start({ target: "TargetTag", intervalMs: 500 });
  await until(() => snap().checks >= 1, 3_000);
  const id = currentId!;
  const removed = sniper.removeSniper(id);
  assert.equal(removed, true);
  assert.equal(sniper.getSniperSnapshot(id), null);
  assert.equal(sniper.listSniperSnapshots().find((t) => t.id === id), undefined);
  currentId = null;
});

test("loading a legacy pre-multi-target sniper.json (never-started, empty target) creates no phantom target", async () => {
  const before = sniper.listSniperSnapshots().length;
  fs.writeFileSync("sniper.json", JSON.stringify({
    runId: null, state: "idle", config: { target: "", intervalMs: 1500, autoClaim: true, notifications: true, doubleCheck: true },
    availability: "unknown", availabilityDetail: null, claim: "waiting", claimReason: null,
    checks: 0, claimAttempts: 0, lastCheckAt: null, lastClaimAt: null, nextCheckAt: null, backoffUntil: null,
    startedAt: null, stoppedAt: null, stopReason: null,
    latency: { availabilityMs: null, avgAvailabilityMs: null, claimMs: null, reactionMs: null, totalMs: null },
    lastClaim: null, eventSeq: 0, events: [],
  }), { mode: 0o600 });
  sniper.initSniper();
  assert.equal(sniper.listSniperSnapshots().length, before, "a never-started legacy sniper should not appear as a target");
});

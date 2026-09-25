import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { setup, control, until } from "./helpers";

const { mock } = await setup();
const { default: app } = await import("../src/app");
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => { server.close(); mock.server.close(); });

beforeEach(() => {
  mock.state.queues = {};
  mock.state.sticky = {};
  mock.state.taken = new Set(["TAKENTAG"]);
  mock.state.reservations.clear();
  mock.state.gamertag = "OldTag";
  mock.state.log.length = 0;
});

const calls = (ep: string) => mock.state.log.filter((l) => l.endpoint === ep);
// The reservation probe also calls the "change" endpoint, but only ever with
// PreviewOnly: true (never applying a change) -- callers checking for a real
// claim's change call should use this, not the raw endpoint filter.
const realChanges = () => calls("change").filter((l) => (l.body as any)?.PreviewOnly !== true);
const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function runList(names: string[], extra: Record<string, unknown>) {
  const res = await post("/gamertag/search", { config: { mode: "list", params: { names } }, rate: 5, ...extra });
  assert.equal(res.status, 201);
  const { sessionId } = (await res.json()) as { sessionId: string };
  let snap: any;
  await until(async () => {
    snap = await (await fetch(`${base}/gamertag/sessions/${sessionId}`)).json();
    return snap.state === "completed";
  }, 10_000);
  return { sessionId, snap };
}

test("server-side auto-claim claims the FIRST confirmed hit only, with the browser closed", async () => {
  const { sessionId, snap } = await runList(["TakenTag", "HitAlpha", "HitBravo"], { runEthanPolicyCheck: true, autoClaim: true });
  // Wait for any in-flight claim to settle.
  await until(async () => {
    const { claims } = (await (await fetch(`${base}/gamertag/claims`)).json()) as { claims: any[] };
    return claims.filter((c) => c.sessionId === sessionId && c.state !== "claiming").length >= 1;
  }, 5_000);
  const final = await (await fetch(`${base}/gamertag/sessions/${sessionId}`)).json() as any;
  const statuses = Object.fromEntries(snap.results.map((r: any) => [r.gamertag, `${r.status}/${r.policy?.status ?? "-"}/${r.alertable}`]));
  assert.deepEqual(statuses, {
    TakenTag: "taken/-/false",
    HitAlpha: "available/approved/true",
    HitBravo: "available/approved/true",
  });
  assert.ok(["HitAlpha", "HitBravo"].includes(final.claimed), `claimed=${final.claimed}`);
  assert.equal(final.autoClaim, false, "auto-claim switches off after the first confirmed claim");
  assert.equal(realChanges().length, 1, "the account is renamed exactly once");
  assert.equal(mock.state.gamertag, final.claimed);
});

test("Double Check still gates auto-claim: policy 409 → UNKNOWN, not alertable, never claimed", async () => {
  await control(mock.url, { sticky: { policy: { status: 409, body: {} } } });
  const { snap } = await runList(["PolicyNope"], { runEthanPolicyCheck: true, autoClaim: true });
  const r = snap.results[0];
  assert.equal(r.status, "unknown");
  assert.equal(r.policy.status, "unavailable");
  assert.equal(r.alertable, false);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(calls("reserve").length, 0);
});

test("Double Check 200 offering only a suffixed name → UNKNOWN, not alertable, never claimed", async () => {
  // Xbox can answer 200 while only offering the name with a suffix attached
  // (or a different classicGamertag) — the exact typed name is actually
  // taken even though the HTTP status alone looks like an approval.
  await control(mock.url, {
    sticky: { policy: { status: 200, body: { classicGamertag: "SuffixTag", gamertag: "SuffixTag", gamertagSuffix: "4821" } } },
  });
  const { snap } = await runList(["SuffixTag"], { runEthanPolicyCheck: true, autoClaim: true });
  const r = snap.results[0];
  assert.equal(r.status, "unknown");
  assert.equal(r.policy.status, "unavailable");
  assert.match(r.policy.message, /#4821/);
  assert.equal(r.alertable, false);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(calls("reserve").length, 0, "never attempts a claim on a name Xbox would only offer with a suffix");
});

test("Double Check 200 with no suffix and a matching name → still APPROVED (no false regression)", async () => {
  await control(mock.url, {
    sticky: { policy: { status: 200, body: { classicGamertag: "CleanTag", gamertag: "CleanTag", gamertagSuffix: "" } } },
  });
  const { snap } = await runList(["CleanTag"], { runEthanPolicyCheck: true });
  const r = snap.results[0];
  assert.equal(r.status, "available");
  assert.equal(r.policy.status, "approved");
  assert.equal(r.alertable, true);
});

test("Double Check approves but the reserve probe finds a suffix-only offer → UNKNOWN, not alertable, never claimed", async () => {
  // The policy endpoint (user.mgt.xboxlive.com) approves cleanly with no
  // suffix info at all — matching what real testing showed: it answers
  // content-policy acceptability, not gamertag-suffix allocation. The
  // reserve probe (gamertag.xboxlive.com, the endpoint confirmed accurate
  // by real claim testing) is the one that reveals the exact name is only
  // offered with a suffix attached.
  await control(mock.url, {
    sticky: {
      policy: { status: 200, body: {} },
      reserve: { status: 200, body: { classicGamertag: "ProbeTag", gamertag: "ProbeTag", gamertagSuffix: "7712" } },
    },
  });
  const { snap } = await runList(["ProbeTag"], { runEthanPolicyCheck: true, autoClaim: true });
  const r = snap.results[0];
  assert.equal(r.status, "unknown");
  assert.equal(r.policy.status, "unavailable");
  assert.match(r.policy.message, /#7712/);
  assert.equal(r.alertable, false);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(calls("change").length, 0, "never attempts a claim on a name Xbox would only offer with a suffix");
});

test("Double Check approves and the reserve probe confirms the exact name → still APPROVED (no false regression)", async () => {
  await control(mock.url, {
    sticky: {
      policy: { status: 200, body: {} },
      // Scripting a sticky reserve response bypasses the mock's normal
      // reservation bookkeeping, so the change-preview step also needs a
      // scripted clean response here (a real reserve success would record
      // the reservation the change endpoint checks for).
      reserve: { status: 200, body: { classicGamertag: "ProbeCleanTag", gamertag: "ProbeCleanTag", gamertagSuffix: "" } },
      change: { status: 200, body: { Gamertag: "ProbeCleanTag", GamertagSuffix: "", hasFree: true } },
    },
  });
  const { snap } = await runList(["ProbeCleanTag"], { runEthanPolicyCheck: true });
  const r = snap.results[0];
  assert.equal(r.status, "available");
  assert.equal(r.policy.status, "approved");
  assert.equal(r.alertable, true);
});

test("auto-claim OFF → hits are reported, nothing is claimed; Double Check OFF classification unchanged", async () => {
  const { snap } = await runList(["TakenTag", "FreeOnly"], { autoClaim: false });
  const statuses = Object.fromEntries(snap.results.map((r: any) => [r.gamertag, `${r.status}/${r.alertable}`]));
  assert.deepEqual(statuses, { TakenTag: "taken/false", FreeOnly: "available/true" });
  assert.equal(calls("policy").length, 0);
});

test("Double Check OFF: the reserve probe still catches a suffix-only offer → UNKNOWN, not alertable", async () => {
  // The suffix problem is independent of the optional Double Check toggle:
  // a hit must never be reported as available on the strength of the
  // primary CDN check alone without confirming Xbox will grant the exact
  // typed name, whether or not Double Check is turned on.
  await control(mock.url, {
    sticky: { reserve: { status: 200, body: { classicGamertag: "NoDcTag", gamertag: "NoDcTag", gamertagSuffix: "9001" } } },
  });
  const { snap } = await runList(["NoDcTag"], { autoClaim: false });
  const r = snap.results[0];
  assert.equal(r.status, "unknown");
  assert.equal(r.policy.status, "unavailable");
  assert.match(r.policy.message, /#9001/);
  assert.equal(r.alertable, false);
  assert.equal(calls("policy").length, 0, "Double Check is off; only the reserve probe ran");
});

test("reserve looks clean but the change-preview reveals a suffix → UNKNOWN, not alertable", async () => {
  // The reserve call alone can look clean (no suffix fields) while the real
  // change step -- previewed here, never applied -- is where Xbox actually
  // decides the exact classic name isn't grantable.
  await control(mock.url, {
    sticky: { change: { status: 200, body: { Gamertag: "PreviewTag", GamertagSuffix: "3344" } } },
  });
  const { snap } = await runList(["PreviewTag"], { autoClaim: false });
  const r = snap.results[0];
  assert.equal(r.status, "unknown");
  assert.equal(r.policy.status, "unavailable");
  assert.match(r.policy.message, /#3344/);
  assert.equal(r.alertable, false);
});

test("Double Check OFF: the reserve probe confirms a clean exact-name offer → still APPROVED", async () => {
  const { snap } = await runList(["FreeOnly2"], { autoClaim: false });
  const r = snap.results[0];
  assert.equal(r.status, "available");
  assert.equal(r.alertable, true);
});

test("POST /gamertag/claim: status codes and response shape (bot-compatible), no secrets", async () => {
  const ok = await post("/gamertag/claim", { gamertag: "RouteTag" });
  const okBody = await ok.json() as any;
  assert.equal(ok.status, 200);
  assert.equal(okBody.success, true);
  assert.equal(okBody.state, "claimed");
  assert.match(okBody.message, /confirmed by Xbox/);

  const taken = await post("/gamertag/claim", { gamertag: "TakenTag" });
  const tb = await taken.json() as any;
  assert.equal(taken.status, 409);
  assert.equal(tb.success, false);
  assert.equal(tb.error, "taken");

  const bad = await post("/gamertag/claim", { gamertag: "1x" });
  assert.equal(bad.status, 400);

  await control(mock.url, { queues: { reserve: [{ status: 429, body: {} }] } });
  const rl = await post("/gamertag/claim", { gamertag: "RateTag" });
  assert.equal(rl.status, 429);
  assert.equal(((await rl.json()) as any).state, "rate_limited");

  const all = JSON.stringify(await (await fetch(`${base}/gamertag/claims`)).json()) + JSON.stringify(okBody) + JSON.stringify(tb);
  assert.ok(!/xsts\||ms-at-|rt-\d|xbl-user-/.test(all), "no token in API responses");
});

test("GET /auth/xbox/status exposes readiness + masked identity, never tokens", async () => {
  const st = await (await fetch(`${base}/auth/xbox/status`)).json() as any;
  assert.equal(st.account.ready, true);
  assert.equal(st.account.gamertag !== null, true);
  assert.match(st.account.maskedXuid, /^2533•+0001$/);
  assert.ok(!/xsts\||ms-at-|rt-|xbl-user-/.test(JSON.stringify(st)));
});

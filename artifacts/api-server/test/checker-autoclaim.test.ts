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
  assert.equal(calls("change").length, 1, "the account is renamed exactly once");
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

test("auto-claim OFF → hits are reported, nothing is claimed; Double Check OFF classification unchanged", async () => {
  const { snap } = await runList(["TakenTag", "FreeOnly"], { autoClaim: false });
  const statuses = Object.fromEntries(snap.results.map((r: any) => [r.gamertag, `${r.status}/${r.alertable}`]));
  assert.deepEqual(statuses, { TakenTag: "taken/false", FreeOnly: "available/true" });
  assert.equal(calls("policy").length, 0);
});

test("Double Check OFF: the reserve probe still catches a suffix-only offer, using Xbox's real response fields → UNKNOWN, not alertable", async () => {
  // Real Xbox response shape (captured live from account.xbox.com):
  // {"promptForClassicGamertag":false,"classicTranslationLevel":"None",
  //  "uniqueModernGamertag":"NP0R#9401","modernGamertagSuffix":"9401",
  //  "modernGamertag":"NP0R","gamertag":"NP0R9401"} — no classicGamertag/
  // gamertagSuffix fields at all, which is what the first three attempts at
  // this wrongly assumed existed.
  await control(mock.url, {
    sticky: {
      reserve: {
        status: 200,
        body: {
          promptForClassicGamertag: false, classicTranslationLevel: "None",
          uniqueModernGamertag: "SUFTAG#9401", modernGamertagSuffix: "9401",
          modernGamertag: "SUFTAG", gamertag: "SUFTAG9401",
        },
      },
    },
  });
  const { snap } = await runList(["SufTag"], { autoClaim: false });
  const r = snap.results[0];
  assert.equal(r.status, "unknown");
  assert.equal(r.policy.status, "unavailable");
  assert.match(r.policy.message, /SUFTAG#9401/);
  assert.equal(r.alertable, false);
});

test("Double Check OFF: the reserve probe confirms a genuinely free classic name → still APPROVED", async () => {
  const { snap } = await runList(["FreeOnly2"], { autoClaim: false });
  const r = snap.results[0];
  assert.equal(r.status, "available");
  assert.equal(r.alertable, true);
  assert.equal(calls("reserve").length, 1);
});

test("a burst of hits needing the probe all at once does not freeze the search", async () => {
  // Regression test for a real freeze: a burst of simultaneous "available"
  // hits used to all queue single-file behind one account's probe spacing,
  // each holding its worker's search slot the whole time it waited its
  // turn -- enough of them piling up starved every worker and the search
  // never finished. The probe's queue-depth cap should make excess probes
  // in a burst fail fast (skipped, not alertable) instead of blocking.
  await control(mock.url, { latencyMs: { reserve: 300 } });
  const names = Array.from({ length: 20 }, (_, i) => `BurstTag${i}`);
  const { snap } = await runList(names, { rate: 20 });
  assert.equal(snap.results.length, 20, "every hit got a result instead of the search stalling");
  const skipped = snap.results.filter((r: any) => r.policy?.message?.includes("already queued"));
  assert.ok(skipped.length > 0, "the queue-depth cap actually engaged under this burst");
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

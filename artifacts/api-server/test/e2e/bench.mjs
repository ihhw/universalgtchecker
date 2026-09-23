// Latency benchmark of the production server against the local mock.
// Measures OUR pipeline (check → classify → claim → confirm). With the mock
// on localhost, network time is ~0; the "simulated RTT" run adds a fixed
// delay per Xbox endpoint to show how latency composes. NOT live Xbox numbers.
import { spawn } from "node:child_process";
import fs from "node:fs";
const API_DIR = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const MOCK = "http://127.0.0.1:4599", APP = "http://127.0.0.1:8091";
const RUN = `${process.env.TMPDIR ?? "/tmp"}/uc-bench-run`; fs.rmSync(RUN, { recursive: true, force: true }); fs.mkdirSync(RUN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const e = Date.now() + ms; while (Date.now() < e) { try { if (await fn()) return true; } catch {} await sleep(10); } return false; }
const ctl = (b) => fetch(`${MOCK}/__control/set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const j = async (p, init) => (await fetch(`${APP}/api${p}`, init)).json();
const mock = spawn("node", ["--import", "tsx", "test/mock-xbox.ts"], { cwd: API_DIR, env: { ...process.env, MOCK_PORT: "4599" }, stdio: "ignore" });
await until(async () => (await fetch(`${MOCK}/__control/state`)).ok);
// Seed a signed-in account (refresh token accepted by the mock).
fs.writeFileSync(`${RUN}/.xbox-auth.json`, JSON.stringify({ version: 2, activeAccountId: "a", accounts: [{ id: "a", xuid: null, gamertag: null, addedAt: Date.now(), msRefreshToken: "rt-seed" }] }));
const srv = spawn("node", [`${API_DIR}/dist/index.mjs`], { cwd: RUN, env: { ...process.env, PORT: "8091", NODE_ENV: "production", XBOX_MOCK_BASE: MOCK, LOG_LEVEL: "warn" }, stdio: "ignore" });
await until(async () => (await j("/auth/xbox/verify", { method: "POST" })).account.ready);

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const stats = (a) => `n=${a.length} min=${Math.min(...a)} p50=${pct(a, 50)} p95=${pct(a, 95)} max=${Math.max(...a)} ms`;

async function run(label, rtt, n) {
  await ctl({ latencyMs: { cdn: rtt, policy: rtt, reserve: rtt, change: rtt } });
  const L = { availabilityMs: [], reactionMs: [], claimMs: [], totalMs: [], reserveMs: [], changeMs: [] };
  for (let i = 0; i < n; i++) {
    await sleep(400); // let the existing 350 ms Double Check spacing window lapse
    const tag = `Bench${label[0]}${i}`;
    await ctl({ gamertag: "OldTag", taken: ["TAKENTAG"] });
    const r = await fetch(`${APP}/api/xbox/sniper/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: tag, intervalMs: 500 }) });
    if (r.status !== 201) throw new Error(await r.text());
    await until(async () => (await j("/xbox/sniper")).state === "claimed");
    const s = await j("/xbox/sniper");
    for (const k of ["availabilityMs", "reactionMs", "claimMs", "totalMs"]) L[k].push(s.latency[k]);
    L.reserveMs.push(s.lastClaim.latency.reserveMs); L.changeMs.push(s.lastClaim.latency.changeMs);
  }
  console.log(`\n== ${label} (mock adds ${rtt} ms per Xbox request) ==`);
  console.log(`availability (CDN + Double Check): ${stats(L.availabilityMs)}`);
  console.log(`reaction (available → claim sent): ${stats(L.reactionMs)}`);
  console.log(`claim reserve step:               ${stats(L.reserveMs)}`);
  console.log(`claim change step:                ${stats(L.changeMs)}`);
  console.log(`claim total:                      ${stats(L.claimMs)}`);
  console.log(`end-to-end (check start → CLAIMED): ${stats(L.totalMs)}`);
}
await run("localhost", 0, 30);
await run("simulated", 40, 30);
srv.kill(); mock.kill();

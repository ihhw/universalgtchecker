// End-to-end run of the PRODUCTION build in a real browser, against the local
// mock of the Microsoft/Xbox endpoints (live Xbox hosts are blocked in this
// sandbox). Every assertion below reads real app/server state.
import { createRequire } from "node:module";
// Playwright is not a repo dependency: resolve it from the current directory.
const { chromium } = createRequire(`${process.cwd()}/`)("playwright");
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const API_DIR = `${REPO}/artifacts/api-server`;
const RUN = `${process.env.TMPDIR ?? "/tmp"}/uc-e2e-run`;
const SHOTS = process.env.SHOTS ?? `${process.env.TMPDIR ?? "/tmp"}/uc-e2e-shots`;
const MOCK = "http://127.0.0.1:4599";
const PORT = 8090;
const APP = `http://127.0.0.1:${PORT}`;

fs.rmSync(RUN, { recursive: true, force: true });
fs.mkdirSync(RUN, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(step); }
  return false;
}
const ctl = (body) => fetch(`${MOCK}/__control/set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const api = async (p, init) => (await fetch(`${APP}/api${p}`, init)).json();

function startMock() {
  const p = spawn("node", ["--import", "tsx", "test/mock-xbox.ts"], { cwd: API_DIR, env: { ...process.env, MOCK_PORT: "4599" }, stdio: "ignore" });
  return p;
}
let server;
function startServer() {
  const log = fs.openSync(`${RUN}/server.log`, "a");
  server = spawn("node", ["--enable-source-maps", `${API_DIR}/dist/index.mjs`], {
    cwd: RUN,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production", XBOX_MOCK_BASE: MOCK, LOG_LEVEL: "info" },
    stdio: ["ignore", log, log],
  });
  return until(async () => (await fetch(`${APP}/api/healthz`).catch(() => null))?.ok || (await fetch(`${APP}/`).catch(() => null))?.ok, 10_000);
}
async function stopServer() {
  const done = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await done;
}

const mock = startMock();
await until(async () => (await fetch(`${MOCK}/__control/state`).catch(() => null))?.ok, 10_000);
await ctl({ taken: ["TARGETTAG", "TAKENTAG"] });
check("production server starts", await startServer());

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
const failedRequests = [];
let restarting = false;
page.on("requestfailed", (r) => failedRequests.push({ text: `${r.failure()?.errorText} ${r.url()}`, err: r.failure()?.errorText ?? "", url: r.url(), restarting }));

// ── Pages load ───────────────────────────────────────────────────────────────
await page.goto(`${APP}/xbox`);
check("Xbox checker page loads", await page.getByRole("heading", { name: "Xbox" }).isVisible());
check("sidebar shows Xbox → Checker / Sniper", await page.getByRole("link", { name: "Sniper" }).first().isVisible() && await page.getByRole("link", { name: "Checker" }).first().isVisible());
await page.getByRole("link", { name: "Sniper" }).first().click();
await page.waitForURL("**/xbox/sniper");
check("Sniper page loads", await page.getByRole("heading", { name: "Sniper" }).isVisible());
check("account shows NOT CONNECTED before sign-in", await page.getByText("NOT CONNECTED").first().isVisible());
await page.screenshot({ path: `${SHOTS}/01-sniper-not-connected.png`, fullPage: true });

// ── Connect Xbox (device code) ──────────────────────────────────────────────
await page.getByRole("button", { name: "CONNECT XBOX", exact: true }).click();
check("device code shown in dialog", await until(() => page.getByText("MOCK1234").isVisible(), 8_000));
await page.screenshot({ path: `${SHOTS}/02-connect-device-code.png` });
const connected = await until(async () => (await page.getByRole("dialog").getByText("CONNECTED", { exact: true }).isVisible()), 15_000);
check("dialog shows CONNECTED after Microsoft → Xbox Live → XSTS → XUID", connected);
const dlg = await page.getByRole("dialog").innerText().catch(() => "");
check("dialog shows masked email", dlg.includes("te•••@e•••.com"), dlg.replace(/\s+/g, " ").slice(0, 200));
check("dialog shows Xbox identity (gamertag + masked XUID)", dlg.includes("OldTag · 2533••••••••0001"));
check("dialog shows Claiming READY", /Claiming\s+READY/i.test(dlg));
await page.screenshot({ path: `${SHOTS}/03-connected.png` });
await page.keyboard.press("Escape");
const st = await api("/auth/xbox/status");
check("status API exposes no tokens", !/ms-at-|rt-\d|xbl-user-|xsts\|/.test(JSON.stringify(st)));

// ── Start sniper on a TAKEN tag ─────────────────────────────────────────────
await page.locator("#sniper-target").fill("TargetTag");
await page.getByRole("radio", { name: "500 ms" }).click();
await page.getByRole("button", { name: "START SNIPER" }).click();
check("state WATCHING after start", await until(() => page.getByRole("status").filter({ hasText: "WATCHING" }).first().isVisible(), 5_000));
check("live activity shows real TAKEN checks", await until(() => page.getByText(/TargetTag — TAKEN \(CDN HTTP 200, \d+ms\)/).first().isVisible(), 5_000));
await sleep(1200);
await page.screenshot({ path: `${SHOTS}/04-watching.png`, fullPage: true });

// ── Browser refresh mid-run ─────────────────────────────────────────────────
const before = (await api("/xbox/sniper")).checks;
await page.reload();
check("after refresh: still WATCHING (recovered from backend)", await until(() => page.getByRole("status").filter({ hasText: "WATCHING" }).first().isVisible(), 5_000));
check("after refresh: activity history restored", await until(() => page.getByText("Sniper started — target TargetTag").isVisible(), 5_000));
check("after refresh: target field shows running config", (await page.locator("#sniper-target").inputValue()) === "TargetTag");
check("backend kept checking across refresh", await until(async () => (await api("/xbox/sniper")).checks > before, 3_000));

// ── SSE disconnected: polling keeps the UI live ─────────────────────────────
await page.route("**/api/xbox/sniper/stream", (r) => r.abort());
await page.reload();
check("SSE blocked → indicator shows POLLING", await until(() => page.getByText("POLLING").isVisible(), 5_000));
const attemptsText = async () => (await page.locator("p.eyebrow", { hasText: "Attempts" }).locator("xpath=..").innerText());
const a1 = await attemptsText();
await sleep(2_500);
const a2 = await attemptsText();
check("without SSE the Attempts counter still advances (snapshot polling)", a1 !== a2, `${a1.replace(/\s+/g, " ")} → ${a2.replace(/\s+/g, " ")}`);
await page.unroute("**/api/xbox/sniper/stream");
await page.reload();
check("SSE restored → indicator LIVE", await until(() => page.getByText("LIVE", { exact: true }).isVisible(), 5_000));

// ── 429 from Xbox ───────────────────────────────────────────────────────────
await ctl({ queues: { cdn: [{ status: 429, headers: { "Retry-After": "2" } }] } });
check("429 surfaces as RATE LIMITED in activity", await until(() => page.getByText(/RATE LIMITED — Xbox CDN returned HTTP 429/).first().isVisible(), 5_000));
await page.screenshot({ path: `${SHOTS}/05-rate-limited.png`, fullPage: true });

// ── Network failure on a check ──────────────────────────────────────────────
await ctl({ queues: { cdn: [{ drop: true }] } });
check("dropped connection surfaces as NETWORK ERROR, sniper keeps watching", await until(() => page.getByText(/NETWORK ERROR \(CDN request failed/).first().isVisible(), 8_000));

// ── Tag released → AVAILABLE → CLAIMING → CLAIMED ──────────────────────────
await ctl({ taken: ["TAKENTAG"] });
check("UI shows CLAIMED after Xbox confirms", await until(() => page.getByRole("status").filter({ hasText: "CLAIMED" }).first().isVisible(), 8_000));
check("activity: Claim request sent", await page.getByRole("main").getByText("Claim request sent for TargetTag").isVisible());
check("activity: Claim confirmed by Xbox", await page.getByRole("main").getByText(/Claim confirmed by Xbox — TargetTag is now this account's gamertag/).isVisible());
const snap = await api("/xbox/sniper");
const mockState = await (await fetch(`${MOCK}/__control/state`)).json();
check("backend: claimed + mock account renamed", snap.state === "claimed" && snap.claim === "claimed" && mockState.gamertag === "TargetTag");
check("latency fields measured", ["availabilityMs", "claimMs", "reactionMs", "totalMs"].every((k) => typeof snap.latency[k] === "number"), JSON.stringify(snap.latency));
await page.screenshot({ path: `${SHOTS}/06-claimed.png`, fullPage: true });

// ── Claim failure path through the UI ───────────────────────────────────────
await ctl({ gamertag: "OldTag", taken: ["TAKENTAG"], sticky: { reserve: { status: 409, body: { description: "Gamertag is not available" } } } });
await page.locator("#sniper-target").fill("FailTag");
await page.getByRole("button", { name: "START SNIPER" }).click();
check("claim failure shows CLAIM FAILED with Xbox's reason", await until(() => page.getByRole("main").getByText(/CLAIM FAILED: Xbox reports "FailTag" is taken or reserved by someone else \(HTTP 409\): Gamertag is not available/).first().isVisible(), 8_000));
check("never shows CLAIMED for the failed tag", (await api("/xbox/sniper")).claim === "claim_failed");
await page.screenshot({ path: `${SHOTS}/07-claim-failed.png`, fullPage: true });
await page.getByRole("button", { name: "STOP" }).click();
check("STOP → STOPPED", await until(() => page.getByRole("status").filter({ hasText: "STOPPED" }).first().isVisible(), 5_000));
await ctl({ sticky: { reserve: null } });

// ── Server restart while watching → resumes ─────────────────────────────────
await fetch(`${MOCK}/__control/set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taken: ["TAKENTAG", "RESUMETAG"] }) });
// clear sticky by resetting that key
await page.locator("#sniper-target").fill("ResumeTag");
await page.getByRole("button", { name: "START SNIPER" }).click();
await until(async () => (await api("/xbox/sniper")).checks >= 2, 5_000);
restarting = true;
await stopServer();
check("server stopped (SIGTERM) mid-run", true);
await sleep(500);
await startServer();
await sleep(1_500);
restarting = false;
const resumed = await until(async () => {
  const s = await api("/xbox/sniper");
  return s.state === "watching" && s.events.some((e) => e.message === "Sniper resumed after a server restart");
}, 8_000);
check("after server restart the run resumes (persisted state)", resumed);
check("frontend recovers after server restart", await until(() => page.getByRole("main").getByText("Sniper resumed after a server restart").isVisible(), 8_000));
await page.getByRole("button", { name: "STOP" }).click();

// ── Mobile layout ───────────────────────────────────────────────────────────
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await m.newPage();
mp.on("pageerror", (e) => consoleErrors.push(`mobile pageerror: ${e.message}`));
await mp.goto(`${APP}/xbox/sniper`);
await mp.waitForTimeout(800);
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check("mobile: no horizontal overflow", overflow <= 0, `overflow ${overflow}px`);
await mp.screenshot({ path: `${SHOTS}/08-mobile.png`, fullPage: true });
await mp.getByRole("button", { name: "Open menu" }).click();
check("mobile menu lists Sniper", await mp.getByRole("link", { name: "Sniper" }).isVisible());
await mp.screenshot({ path: `${SHOTS}/09-mobile-menu.png` });

// ── Other pages still load ──────────────────────────────────────────────────
for (const p of ["/xbox", "/hits", "/activity", "/status", "/settings"]) {
  await page.goto(`${APP}${p}`);
  await page.waitForTimeout(400);
  check(`page ${p} renders`, (await page.locator("main").innerText()).length > 0);
}
await page.goto(`${APP}/xbox`);
await page.screenshot({ path: `${SHOTS}/10-checker.png`, fullPage: true });

// Resource failures are classified by URL: Google Fonts can't be fetched in
// this sandbox (its TLS proxy CA isn't trusted by Chromium), and the SSE
// stream was aborted on purpose above. Anything else counts as an app error.
const expected = (f) =>
  /fonts\.(googleapis|gstatic)\.com/.test(f.url) ||                 // sandbox: font CDN TLS blocked
  f.err === "net::ERR_ABORTED" ||                                    // reload/navigation cancels in-flight requests
  (/\/api\/xbox\/sniper\/stream/.test(f.url) && f.err === "net::ERR_FAILED") || // route aborted on purpose
  (f.restarting && /ERR_CONNECTION_REFUSED|ERR_INCOMPLETE_CHUNKED_ENCODING/.test(f.err)); // deliberate restart
const unexpectedReq = failedRequests.filter((f) => !expected(f)).map((f) => f.text);
console.log("failed requests (deduped):", [...new Set(failedRequests.map((f) => f.text.replace(/\?.*$/, "") + (f.restarting ? " [during restart]" : "")))]);
const appErrors = consoleErrors.filter((e) => !/^Failed to load resource/.test(e));
check("no browser runtime/console errors from the app", appErrors.length === 0, appErrors.slice(0, 5).join(" | "));
check("no unexpected failed requests", unexpectedReq.length === 0, unexpectedReq.slice(0, 5).join(" | "));

await browser.close();
await stopServer();
mock.kill();

const log = fs.readFileSync(`${RUN}/server.log`, "utf8");
check("server log has no tokens", !/ms-at-\d|"rt-\d|rt-\d+"|xbl-user-|xsts\||XBL3\.0 x=/.test(log));
check("server log has no errors", !/"level":(50|60)/.test(log), (log.match(/.*"level":(50|60).*/g) ?? []).slice(0, 2).join("\n"));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

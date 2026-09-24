import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  StartDiscordSearchBody,
  GetDiscordSessionParams,
  CancelDiscordSessionParams,
  StartDiscordSearchResponse,
  GetDiscordSessionResponse,
  CancelDiscordSessionResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { isBlockedByContentFilter } from "../lib/content-filter";
import { checkDiscordUsername, currentMaxConcurrency, currentMaxRate, type ResultStatus } from "../lib/discord-availability";
import { compileGeneration, type Generator } from "../lib/discord-generator";
import { validateDiscordUsername } from "../lib/discord-validation";
import { pushActivity } from "../lib/activity";
import { getWebhookTarget, sendWebhookPayload } from "../lib/webhook-store";
import { getPublicProxyState, setProxies, clearProxies } from "../lib/discord-proxy-store";

const router: IRouter = Router();

interface DiscordResult {
  username: string;
  status: ResultStatus;
  /** Monotonic per-session sequence number so clients can de-duplicate SSE replays. */
  seq?: number;
}

interface Session {
  sessionId: string;
  mode: string;
  /** Short mode label shown in the live feed. */
  label: string;
  generator: Generator;
  /** True once a finite source (list, fixed pattern) has been used up. */
  exhausted: boolean;
  rate: number;
  state: "running" | "completed" | "cancelled";
  paused: boolean;
  attempts: number;
  found: number;
  taken: number;
  unknown: number;
  results: DiscordResult[];
  abort: AbortController;
  sseClients: Response[];
  recentCheckTs: number[];
}

const sessions = new Map<string, Session>();

// Auto-save paths, kept separate from the Xbox checker's files.
const RESULTS_FILE = path.join(process.cwd(), "discord-results.txt");
const STATE_FILE = path.join(process.cwd(), "discord-state.json");
// Persistent deduplication: once an available username has been emitted, it
// is never emitted as available again, including after a server restart.
const shownAvailable = new Set<string>();

try {
  const saved = fs.readFileSync(RESULTS_FILE, "utf8");
  for (const name of saved.split(/\r?\n/)) {
    const normalized = name.trim().toLowerCase();
    if (normalized) shownAvailable.add(normalized);
  }
} catch {
  // The results file is created on the first newly available username.
}

function appendResultToFile(username: string): void {
  shownAvailable.add(username.trim().toLowerCase());
  try {
    fs.appendFileSync(RESULTS_FILE, username + "\n", "utf8");
  } catch { /* ignore — non-critical */ }
}

/** Sends an availability alert to the server-side configured Discord webhook. */
async function notifyDiscordWebhook(username: string, label: string, sessionId: string): Promise<void> {
  const target = getWebhookTarget();
  if (!target) return;
  const ok = await sendWebhookPayload(target, {
    username: "Universal Checker",
    embeds: [{
      title: username,
      description: "Available Discord username",
      color: 0xd4a72c,
      fields: [{ name: "Mode", value: label, inline: true }],
      footer: { text: `Universal Checker • ${sessionId.slice(0, 8)}` },
    }],
  });
  if (!ok) logger.warn({ username }, "Discord webhook availability alert failed");
}

function saveState(sessionId: string, label: string, found: string[]): void {
  try {
    const existing: Record<string, unknown> = (() => {
      try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>; }
      catch { return {}; }
    })();
    existing[sessionId] = { mode: label, found, savedAt: new Date().toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(existing, null, 2), "utf8");
  } catch { /* ignore */ }
}

// Clean up completed/cancelled sessions after 10 minutes
setInterval(() => {
  for (const [id, session] of sessions.entries()) {
    if (session.state !== "running") sessions.delete(id);
  }
}, 60_000);

// ─── Semaphore ────────────────────────────────────────────────────────────────
// Discord's unauthenticated username endpoint has no proxy pool behind it here
// (a single server egress IP), so concurrency is kept far lower than the Xbox
// checker's CDN-backed one to stay under Discord's rate limits.

class Semaphore {
  private count: number;
  private waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.count = limit;
  }

  acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }
}

// ─── SSE broadcast ───────────────────────────────────────────────────────────

function broadcastSSE(session: Session, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of session.sseClients) {
    try { client.write(payload); } catch { /* dead client */ }
  }
}

function computeCps(session: Session): number {
  const now = Date.now();
  const window = 5_000;
  session.recentCheckTs = session.recentCheckTs.filter((t) => now - t < window);
  return Math.round((session.recentCheckTs.length / (window / 1000)) * 10) / 10;
}

// ─── Search runner ───────────────────────────────────────────────────────────

async function runSearch(session: Session): Promise<void> {
  const { abort } = session;
  const concurrency = Math.max(1, Math.min(currentMaxConcurrency(), session.rate));
  const sem = new Semaphore(concurrency);
  const minIntervalMs = Math.max(0, Math.ceil((concurrency / session.rate) * 1_000));

  const SESSION_TRIED_LIMIT = 100_000;
  const sessionTried = new Set<string>();
  const sessionTriedOrder: string[] = [];
  let sessionTriedCursor = 0;
  const foundNames: string[] = [];

  function rememberTried(name: string): void {
    sessionTried.add(name);
    sessionTriedOrder.push(name);
    if (sessionTriedOrder.length - sessionTriedCursor > SESSION_TRIED_LIMIT) {
      const old = sessionTriedOrder[sessionTriedCursor++];
      if (old) sessionTried.delete(old);
      if (sessionTriedCursor > 10_000 && sessionTriedCursor * 2 > sessionTriedOrder.length) {
        sessionTriedOrder.splice(0, sessionTriedCursor);
        sessionTriedCursor = 0;
      }
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (ms <= 0 || abort.signal.aborted) { resolve(); return; }
      const t = setTimeout(resolve, ms);
      abort.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  async function worker(): Promise<void> {
    while (session.state === "running" && !abort.signal.aborted) {
      while (session.paused && session.state === "running" && !abort.signal.aborted) {
        await sleep(250);
      }
      if (session.state !== "running" || abort.signal.aborted) return;

      let name: string | null = null;
      for (let draws = 0; draws < 1_000 && name === null; draws++) {
        const candidate = session.generator.next();
        if (candidate === null) {
          session.exhausted = true;
          return;
        }
        if (!validateDiscordUsername(candidate).valid) continue;
        if (isBlockedByContentFilter(candidate)) continue;
        if (sessionTried.has(candidate)) continue;
        name = candidate;
      }
      if (name === null) {
        sessionTried.clear();
        continue;
      }

      rememberTried(name);
      const checkStart = Date.now();

      await sem.acquire();
      const perCheckSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
      let status: ResultStatus;
      try {
        status = await checkDiscordUsername(name, perCheckSignal);
        if (status === "available" && shownAvailable.has(name)) status = "taken";
      } catch {
        status = "error";
      } finally {
        sem.release();
      }

      if (session.state !== "running") return;

      session.recentCheckTs.push(Date.now());
      session.attempts++;
      if (status === "taken") session.taken++;
      else if (status !== "available") session.unknown++;
      const result: DiscordResult = { username: name, status, seq: session.attempts };
      session.results.push(result);
      if (session.results.length > 2_000) session.results.splice(0, session.results.length - 2_000);

      if (status === "available") {
        session.found++;
        foundNames.push(name);
        appendResultToFile(name);
        saveState(session.sessionId, session.label, foundNames);
        void notifyDiscordWebhook(name, session.label, session.sessionId);
      }

      pushActivity({
        username: name,
        platform: "discord",
        format: session.label,
        status: status === "available" ? "available" : status === "taken" ? "taken" : "unknown",
        alertable: status === "available",
        sessionId: session.sessionId,
      });

      const cps = computeCps(session);
      broadcastSSE(session, "result", { ...result, cps, attempts: session.attempts, found: session.found });

      const elapsed = Date.now() - checkStart;
      const remaining = minIntervalMs - elapsed;
      if (remaining > 0) await sleep(remaining);
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => sleep(i * 10).then(() => worker())),
  );

  if (session.exhausted && session.state === "running") session.state = "completed";
  broadcastSSE(session, "done", { found: session.found, attempts: session.attempts, state: session.state });

  for (const client of session.sseClients) {
    try { client.end(); } catch { /* ignore */ }
  }
  session.sseClients = [];
}

// ─── Verify single username ────────────────────────────────────────────────────

async function verifyUsername(name: string): Promise<{ status: ResultStatus; confidence: "high" | "low" }> {
  if (isBlockedByContentFilter(name)) return { status: "unknown", confidence: "low" };
  try {
    const status = await checkDiscordUsername(name, AbortSignal.timeout(15_000));
    return { status, confidence: status === "error" ? "low" : "high" };
  } catch {
    return { status: "error", confidence: "low" };
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/discord/verify/:username", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.username) ? req.params.username[0] : req.params.username;
  const name = (raw ?? "").toLowerCase();
  const validation = validateDiscordUsername(name);
  if (!validation.valid) {
    res.status(400).json({ error: validation.errors[0], errors: validation.errors }); return;
  }
  req.log.info({ name }, "Verifying Discord username");
  const { status, confidence } = await verifyUsername(name);
  res.json({ username: name, status, confidence });
});

router.post("/discord/validate", (req, res): void => {
  const names = (req.body as { usernames?: unknown } | undefined)?.usernames;
  if (!Array.isArray(names) || names.length === 0 || names.length > 500) {
    res.status(400).json({ error: "usernames must be a list of 1 to 500 entries." });
    return;
  }
  res.json({ results: names.map((n) => validateDiscordUsername(typeof n === "string" ? n.toLowerCase() : n)) });
});

const PREVIEW_SAMPLES = 8;
const PREVIEW_DRAWS = 40;

function previewSamples(outcome: ReturnType<typeof compileGeneration>): string[] {
  if (!outcome.ok || !outcome.create) return [];
  const gen = outcome.create();
  const seen = new Set<string>();
  for (let i = 0; i < PREVIEW_DRAWS && seen.size < PREVIEW_SAMPLES; i++) {
    const s = gen.next();
    if (s === null) break;
    seen.add(s);
  }
  return [...seen];
}

router.post("/discord/config/validate", (req, res): void => {
  const config = (req.body as { config?: unknown } | undefined)?.config;
  const outcome = compileGeneration(config);
  res.json({
    valid: outcome.ok,
    errors: outcome.errors,
    label: outcome.label,
    info: outcome.info,
    samples: previewSamples(outcome),
  });
});

router.post("/discord/search", async (req: Request, res: Response): Promise<void> => {
  const parsed = StartDiscordSearchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message }); return;
  }

  const { config, rate } = parsed.data;
  const maxRate = currentMaxRate();
  if (!Number.isFinite(rate) || rate < 1 || rate > maxRate) {
    res.status(400).json({ error: `Rate must be between 1 and ${maxRate} checks per second.` });
    return;
  }

  const compiled = compileGeneration(config);
  if (!compiled.ok || !compiled.create) {
    res.status(400).json({ error: compiled.errors[0] ?? "Invalid configuration.", errors: compiled.errors });
    return;
  }

  const sessionId = crypto.randomUUID();
  const abort = new AbortController();

  const session: Session = {
    sessionId,
    mode: config.mode,
    label: compiled.label,
    generator: compiled.create(),
    exhausted: false,
    rate: Math.round(rate),
    state: "running",
    paused: false,
    attempts: 0,
    found: 0,
    taken: 0,
    unknown: 0,
    results: [],
    abort,
    sseClients: [],
    recentCheckTs: [],
  };

  sessions.set(sessionId, session);
  req.log.info({ sessionId, mode: config.mode, rate }, "Starting Discord username search");

  runSearch(session).catch((err) => logger.error({ err, sessionId }, "Discord search error"));

  res.status(201).json(
    StartDiscordSearchResponse.parse({
      sessionId: session.sessionId,
      mode: session.mode,
      label: session.label,
      rate: session.rate,
      state: session.state,
      attempts: session.attempts,
      found: session.found,
      results: session.results,
    }),
  );
});

router.get("/discord/sessions/:sessionId", async (req, res): Promise<void> => {
  const params = GetDiscordSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message }); return;
  }
  const session = sessions.get(params.data.sessionId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  res.json({
    ...GetDiscordSessionResponse.parse({
      sessionId: session.sessionId,
      mode: session.mode,
      label: session.label,
      rate: session.rate,
      state: session.state,
      attempts: session.attempts,
      found: session.found,
      taken: session.taken,
      unknown: session.unknown,
      paused: session.paused,
      results: session.results,
    }),
    paused: session.paused,
    cps: computeCps(session),
  });
});

router.delete("/discord/sessions/:sessionId", async (req, res): Promise<void> => {
  const params = CancelDiscordSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message }); return;
  }
  const session = sessions.get(params.data.sessionId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  session.state = "cancelled";
  session.paused = false;
  session.abort.abort();
  req.log.info({ sessionId: params.data.sessionId }, "Cancelled Discord username search");

  res.json(
    CancelDiscordSessionResponse.parse({
      sessionId: session.sessionId,
      mode: session.mode,
      label: session.label,
      rate: session.rate,
      state: session.state,
      attempts: session.attempts,
      found: session.found,
      results: session.results,
    }),
  );
});

router.post("/discord/sessions/:sessionId/pause", (req, res): void => {
  const rawId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
  const session = sessions.get(rawId ?? "");
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  if (session.state !== "running") { res.status(400).json({ error: "Session is not running" }); return; }
  session.paused = true;
  req.log.info({ sessionId: rawId }, "Paused Discord username search");
  res.json({ sessionId: rawId, paused: true });
});

router.post("/discord/sessions/:sessionId/resume", (req, res): void => {
  const rawId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
  const session = sessions.get(rawId ?? "");
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  if (session.state !== "running") { res.status(400).json({ error: "Session is not running" }); return; }
  session.paused = false;
  req.log.info({ sessionId: rawId }, "Resumed Discord username search");
  res.json({ sessionId: rawId, paused: false });
});

router.get("/discord/sessions/:sessionId/stream", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
  const session = sessions.get(rawId ?? "");
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  session.sseClients.push(res);

  for (const result of session.results) {
    res.write(`event: result\ndata: ${JSON.stringify({
      ...result,
      cps: computeCps(session),
      attempts: session.attempts,
      found: session.found,
    })}\n\n`);
  }

  if (session.state !== "running") {
    res.write(`event: done\ndata: ${JSON.stringify({ found: session.found, attempts: session.attempts, state: session.state })}\n\n`);
    res.end();
    return;
  }

  req.on("close", () => {
    session.sseClients = session.sseClients.filter((c) => c !== res);
  });
});

// ─── Proxy settings ─────────────────────────────────────────────────────────
//
// Discord's unauthenticated endpoint rate-limits a single IP hard. Proxies
// are optional: without any, the checker stays under MAX_RATE_NO_PROXY;
// with some, load spreads across them and a much higher rate is allowed.
// Proxy URLs can carry credentials, so — like the Discord webhook — they are
// stored only on the server and never returned to the browser.

router.get("/discord/settings/proxies", (_req, res): void => {
  res.json({ ...getPublicProxyState(), maxRate: currentMaxRate() });
});

router.put("/discord/settings/proxies", (req, res): void => {
  const body = (req.body ?? {}) as { proxies?: unknown };
  if (typeof body.proxies !== "string") {
    res.status(400).json({ error: "proxies must be a string (one per line)." });
    return;
  }
  const result = setProxies(body.proxies);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ...getPublicProxyState(), maxRate: currentMaxRate(), skipped: result.skipped });
});

router.delete("/discord/settings/proxies", (_req, res): void => {
  clearProxies();
  res.json({ ...getPublicProxyState(), maxRate: currentMaxRate() });
});

/** Lightweight counters for the system-status endpoint. */
export function getDiscordSessionStats(): { running: number; total: number; sseClients: number } {
  let running = 0;
  let sseClients = 0;
  for (const session of sessions.values()) {
    if (session.state === "running") running++;
    sseClients += session.sseClients.length;
  }
  return { running, total: sessions.size, sseClients };
}

export default router;

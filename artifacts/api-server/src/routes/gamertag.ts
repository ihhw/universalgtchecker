import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  StartGamertagSearchBody,
  GetGamertagSessionParams,
  CancelGamertagSessionParams,
  StartGamertagSearchResponse,
  GetGamertagSessionResponse,
  CancelGamertagSessionResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { isBlockedByContentFilter } from "../lib/content-filter";
import { getAuthHeader, getClaimAuthHeader, getXuid } from "../lib/xbox-auth";
import { compileGeneration, type Generator } from "../lib/gamertag-generator";
import { validateXboxGamertag } from "../lib/xbox-validation";
import { pushActivity } from "../lib/activity";
import { getWebhookTarget, sendWebhookPayload } from "../lib/webhook-store";

const router: IRouter = Router();

type ResultStatus = "available" | "taken" | "inappropriate" | "seen" | "unknown" | "error";

interface GamertagResult {
  gamertag: string;
  status: ResultStatus;
  /** Secondary Xbox policy check (Double Check). Kept on the result for transparency. */
  policy?: { status: PolicyStatus; message?: string };
  /**
   * True only when this final result may trigger an availability alert:
   * primary check available AND (double check disabled OR policy approved).
   */
  alertable?: boolean;
  /** Monotonic per-session sequence number so clients can de-duplicate SSE replays. */
  seq?: number;
}

type PolicyStatus =
  | "approved"
  | "banned"
  | "unavailable"
  | "rate_limited"
  | "auth_required"
  | "not_configured"
  | "error";

interface Session {
  sessionId:     string;
  mode:          string;
  /** Short mode label shown in the live feed. */
  label:         string;
  generator:     Generator;
  /** True once a finite source (list, fixed pattern) has been used up. */
  exhausted:     boolean;
  rate:          number;
  runEthanPolicyCheck: boolean;
  state:         "running" | "completed" | "cancelled";
  paused:        boolean;
  attempts:      number;
  found:         number;
  taken:         number;
  unknown:       number;
  results:       GamertagResult[];
  abort:         AbortController;
  sseClients:    Response[];
  recentCheckTs: number[];
}

const sessions = new Map<string, Session>();
const claimsInFlight = new Set<string>();

// Auto-save paths
const RESULTS_FILE = path.join(process.cwd(), "results.txt");
const STATE_FILE   = path.join(process.cwd(), "state.json");
// Persistent deduplication: once an available tag has been emitted, it is
// never emitted as available again, including after a server restart.
const shownAvailable = new Set<string>();
const ETHAN_POLICY_URL = "https://user.mgt.xboxlive.com/gamertags/reserve";
const POLICY_REQUEST_SPACING_MS = 350;
let lastPolicyRequestAt = 0;
let policyRequestQueue = Promise.resolve();

try {
  const saved = fs.readFileSync(RESULTS_FILE, "utf8");
  for (const tag of saved.split(/\r?\n/)) {
    const normalized = tag.trim().toUpperCase();
    if (normalized) shownAvailable.add(normalized);
  }
} catch {
  // The results file is created on the first newly available tag.
}

function appendResultToFile(gamertag: string): void {
  shownAvailable.add(gamertag.trim().toUpperCase());
  try {
    fs.appendFileSync(RESULTS_FILE, gamertag + "\n", "utf8");
  } catch { /* ignore — non-critical */ }
}

/**
 * Sends an availability alert to the server-side configured Discord webhook.
 *
 * Hard gate: only a result whose FINAL state is `available` AND `alertable`
 * is ever sent. With double check enabled, `alertable` is only true when the
 * secondary policy check returned exactly `approved`. Rejected, unknown,
 * auth-failed, rate-limited and network-failed results never reach Discord.
 */
async function notifyDiscordWebhook(
  result: GamertagResult,
  label: string,
  sessionId: string,
): Promise<void> {
  if (result.status !== "available" || result.alertable !== true) return;
  const target = getWebhookTarget();
  if (!target) return;
  const ok = await sendWebhookPayload(target, {
    username: "Universal Checker",
    embeds: [{
      title: result.gamertag,
      description: "Available Xbox gamertag",
      color: 0xd4a72c,
      fields: [
        { name: "Mode", value: label, inline: true },
        { name: "Double check", value: result.policy?.status === "approved" ? "Approved" : "Off", inline: true },
      ],
      footer: { text: `Universal Checker \u2022 ${sessionId.slice(0, 8)}` },
    }],
  });
  if (!ok) logger.warn({ gamertag: result.gamertag }, "Discord webhook availability alert failed");
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

function getReservationId(): string | null {
  // Xbox's reserve API accepts the signed-in account's XUID as the
  // reservationId. The explicit env value remains available for accounts or
  // legacy flows that provide a different reservation identifier.
  const configured = process.env.XBOX_RESERVATION_ID?.trim();
  return configured || getXuid();
}

function waitForPolicyRequestSlot(signal: AbortSignal): Promise<void> {
  const acquire = policyRequestQueue.then(async () => {
    const delay = Math.max(0, POLICY_REQUEST_SPACING_MS - (Date.now() - lastPolicyRequestAt));
    if (delay > 0) await wait(delay, signal);
    if (!signal.aborted) lastPolicyRequestAt = Date.now();
  });
  policyRequestQueue = acquire.catch(() => undefined);
  return acquire;
}

async function runEthanPolicyCheck(
  gamertag: string,
  signal: AbortSignal,
): Promise<{ status: PolicyStatus; message?: string }> {
  const authHeader = await getAuthHeader();
  if (!authHeader) return { status: "auth_required", message: "Sign in to Xbox to run the secondary policy check." };

  const reservationId = getReservationId();
  if (!reservationId) {
    return {
      status: "not_configured",
      message: "The server is missing XBOX_RESERVATION_ID.",
    };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await waitForPolicyRequestSlot(signal);
      const response = await fetch(ETHAN_POLICY_URL, {
        method: "POST",
        signal,
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          "x-xbl-contract-version": "1",
        },
        body: JSON.stringify({ gamertag, reservationId }),
      });

      if (response.status === 200) return { status: "approved" };
      if (response.status === 400) return { status: "banned", message: "Xbox marked this gamertag as unacceptable." };
      if (response.status === 409) return { status: "unavailable", message: "Xbox reports this gamertag is no longer available." };
      if (response.status === 401 || response.status === 403) {
        return { status: "auth_required", message: "The Xbox authorization token was rejected." };
      }
      if (response.status === 429) {
        if (attempt === 0) {
          logger.warn({ gamertag }, "Ethan policy check rate-limited; retrying in 5 seconds");
          await wait(5_000, signal);
          continue;
        }
        return { status: "rate_limited", message: "Xbox rate-limited the secondary policy check." };
      }

      logger.warn({ gamertag, status: response.status }, "Unexpected Ethan policy check response");
      return { status: "error", message: `Xbox returned HTTP ${response.status}.` };
    } catch (err) {
      if (signal.aborted) return { status: "error", message: "Secondary policy check cancelled." };
      logger.warn({ gamertag, err }, "Ethan policy check request failed");
      return { status: "error", message: "Secondary policy check failed." };
    }
  }
  return { status: "rate_limited", message: "Xbox rate-limited the secondary policy check." };
}

// Clean up completed/cancelled sessions after 10 minutes
setInterval(() => {
  for (const [id, session] of sessions.entries()) {
    if (session.state !== "running") sessions.delete(id);
  }
}, 60_000);

// ─── Semaphore ────────────────────────────────────────────────────────────────
// Limits max concurrent in-flight Xbox API requests to prevent rate-limiting
// and Replit resource exhaustion.

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

// ─── Availability check ───────────────────────────────────────────────────────
//
// Endpoint cascade (in priority order):
//   1. gamertag.xboxlive.com/gamertags/{gt}/availability  — authenticated; most accurate
//   2. avatar-ssl.xboxlive.com CDN                        — unauthenticated fallback
//
// NOTE: profile.xboxlive.com is intentionally NOT used — it is rate-limited
// (Retry-After: 299) from Replit server IPs even with valid XSTS auth.

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * Primary check — gamertag.xboxlive.com availability endpoint.
 * Requires a valid XSTS auth header. Returns null if the endpoint is
 * unavailable/rate-limited so the caller can fall through to the CDN.
 */
async function checkViaAvailabilityEndpoint(
  gt: string,
  authHeader: string,
  signal: AbortSignal,
): Promise<Exclude<ResultStatus, "error"> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `https://gamertag.xboxlive.com/gamertags/${encodeURIComponent(gt)}/availability`,
        {
          signal,
          headers: {
            Authorization:            authHeader,
            "x-xbl-contract-version": "1",
            Accept:                   "application/json",
            "Accept-Language":        "en-US",
          },
        },
      );

      if (res.status === 200) {
        // Response body: { "isAvailable": true/false, ... }
        try {
          const data = (await res.json()) as { isAvailable?: boolean };
          if (data.isAvailable === true)  return "available";
          if (data.isAvailable === false) return "taken";
        } catch { /* fall through */ }
        // 200 without parseable isAvailable → treat as available (some API versions)
        return "available";
      }
      if (res.status === 409) return "taken";           // conflict = already taken
      if (res.status === 400) return "inappropriate";   // Xbox rejected tag name
      if (res.status === 401 || res.status === 403) return null; // bad auth → fall through
      if (res.status === 429) {
        if (attempt === 0) {
          const retryAfter = parseInt(res.headers.get("Retry-After") ?? "2", 10);
          const waitMs = Math.min(retryAfter * 1_000, 10_000);
          logger.warn({ gt, retryAfter, waitMs }, "availability endpoint 429 — backing off");
          await wait(waitMs, signal);
          continue;
        }
        return null; // still rate-limited → fall through to CDN
      }

      // 404 here means the /availability sub-path isn't supported by this XSTS token's
      // relying party — fall through to CDN silently.
      if (res.status !== 404) {
        logger.warn({ gt, status: res.status }, "availability endpoint unexpected status");
      }
      return null;
    } catch (err) {
      const name = err instanceof Error ? err.name : "unknown";
      logger.warn({ gt, errName: name }, "availability endpoint fetch error");
      return null;
    }
  }
  return null;
}

/**
 * CDN fallback — avatar-ssl.xboxlive.com.
 * Works without auth. Checks if the gamertag has a classic Xbox 360 CDN entry.
 *   • HTTP 200 → avatar image served → gamertag is TAKEN
 *   • HTTP 401 → not in CDN → likely AVAILABLE (medium confidence for 3–4 char tags)
 */
async function checkViaCDN(
  gt: string,
  signal: AbortSignal,
): Promise<Exclude<ResultStatus, "error"> | null> {
  try {
    const res = await fetch(
      `https://avatar-ssl.xboxlive.com/avatar/${encodeURIComponent(gt)}/avatar-body.png`,
      { signal, headers: { Accept: "image/png" } },
    );

    if (res.status === 200) return "taken";                        // in CDN = profile exists
    if (res.status === 401 || res.status === 404) return "available"; // not in CDN = likely free
    return null;
  } catch {
    return null;
  }
}

// ─── Primary check ────────────────────────────────────────────────────────────
//
// Bulk search uses CDN-only (fastest, no rate-limit issues).
// The authenticated availability endpoint always 404s with the current XSTS
// relying party ("http://xboxlive.com") — so we skip it in bulk mode to
// avoid the extra round-trip and double the effective CPS.
// Single-tag /verify still tries the availability endpoint first.

async function checkGamertag(gt: string, signal: AbortSignal): Promise<ResultStatus> {
  if (isBlockedByContentFilter(gt)) return "inappropriate";

  try {
    // CDN is reliable, fast, and has no rate-limit issues from Replit IPs.
    const cdnResult = await checkViaCDN(gt, signal);
    if (cdnResult !== null) return cdnResult;

    return "error";
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw err;
    }
    return "error";
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
  const now    = Date.now();
  const window = 5_000;
  session.recentCheckTs = session.recentCheckTs.filter((t) => now - t < window);
  return Math.round((session.recentCheckTs.length / (window / 1000)) * 10) / 10;
}

// ─── Search runner ───────────────────────────────────────────────────────────
//
// Uses a Semaphore(10) to cap concurrent in-flight Xbox API requests,
// preventing rate-limiting and resource exhaustion.
// Each worker paces itself to deliver the requested checks-per-second.

async function runSearch(session: Session): Promise<void> {
  const { abort } = session;
  // Cap concurrent in-flight requests at 250 — enough to support high-rate
  // searches without creating an unbounded number of sockets/promises.
  // Higher rates are achieved by having each worker fire more frequently
  // (shorter minIntervalMs) rather than spawning more workers.
  const MAX_CONCURRENCY = 250;
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, session.rate));
  // CDN doesn't aggressively rate-limit — allow all workers in-flight simultaneously
  const sem         = new Semaphore(concurrency);

  // Per-worker interval to hit the target CPS: rate = concurrency / interval_seconds
  // e.g. rate=1000 → concurrency=250 → minIntervalMs=250ms (250 workers × 4/s = 1000 CPS)
  //      rate=150  → concurrency=150 → minIntervalMs=1000ms
  //      rate=100 → concurrency=50 → minIntervalMs=500ms (50 workers × 2/s = 100 CPS)
  //      rate=20  → concurrency=20 → minIntervalMs=1000ms (same as before)
  const minIntervalMs = Math.max(0, Math.ceil((concurrency / session.rate) * 1_000));

  // Keep per-session dedup bounded. At 1000/s an unbounded set would grow
  // forever and eventually make an otherwise healthy infinite search run out
  // of memory.
  const SESSION_TRIED_LIMIT = 100_000;
  const sessionTried = new Set<string>();
  const sessionTriedOrder: string[] = [];
  let sessionTriedCursor = 0;
  const foundTags: string[] = [];

  function rememberTried(tag: string): void {
    sessionTried.add(tag);
    sessionTriedOrder.push(tag);
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
      // Pause loop
      while (session.paused && session.state === "running" && !abort.signal.aborted) {
        await sleep(250);
      }
      if (session.state !== "running" || abort.signal.aborted) return;

      // Draw the next candidate. Generators only emit Xbox-valid names; the
      // check here is defence in depth so an invalid name can never reach Xbox.
      let gt: string | null = null;
      for (let draws = 0; draws < 1_000 && gt === null; draws++) {
        const candidate = session.generator.next();
        if (candidate === null) {
          // A finite source (list, fixed pattern) has been used up.
          session.exhausted = true;
          return;
        }
        if (!validateXboxGamertag(candidate).valid) continue;
        if (sessionTried.has(candidate)) continue;
        gt = candidate;
      }
      if (gt === null) {
        // A small random space is fully covered: start a fresh pass instead of
        // silently ending the user's infinite search.
        sessionTried.clear();
        continue;
      }

      rememberTried(gt);

      const checkStart = Date.now();

      // Acquire semaphore slot before making Xbox API call.
      // IMPORTANT: create the per-check AbortSignal AFTER acquiring the semaphore
      // so the timeout only covers the actual network request, not the queue wait.
      // Xbox can take 5–8 s per check; combined with semaphore wait the old 8 s
      // budget was routinely exceeded, causing silent timeouts shown as "No Auth".
      await sem.acquire();
      // 5s timeout: CDN checks typically complete in <300ms; 5s allows for
      // occasional slow responses while quickly discarding truly stalled ones.
      const perCheckSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
      let status: ResultStatus;
      let policy: { status: PolicyStatus; message?: string } | undefined;
      let alertable = false;
      try {
        status = await checkGamertag(gt, perCheckSignal);
        if (status === "available" && shownAvailable.has(gt.toUpperCase())) {
          status = "seen";
        } else if (status === "available" && session.runEthanPolicyCheck) {
          // The policy endpoint may need its own 5-second 429 backoff, so it
          // gets a fresh budget instead of inheriting the primary check's
          // already-running 5-second timeout.
          const policySignal = AbortSignal.any([
            abort.signal,
            AbortSignal.timeout(20_000),
          ]);
          const policyResult = await runEthanPolicyCheck(gt, policySignal);
          policy = { status: policyResult.status, message: policyResult.message };
          // An available result is only alertable after Ethan approves it.
          // Auth, rate-limit, and network failures must not bypass the
          // secondary check and accidentally send an unverified tag.
          if (policyResult.status !== "approved") {
            status = "unknown";
          }
        }
        // Final alert state. Only a strict primary "available" that is either
        // not double-checked or explicitly policy-approved is alertable.
        alertable = status === "available" &&
          (!session.runEthanPolicyCheck || policy?.status === "approved");
      } catch {
        status = "error";
        alertable = false;
      } finally {
        sem.release();
      }

      if (session.state !== "running") return;

      session.recentCheckTs.push(Date.now());
      session.attempts++;
      if (status === "taken") session.taken++;
      else if (status !== "available") session.unknown++;
      const result: GamertagResult = {
        gamertag: gt, status, policy, alertable, seq: session.attempts,
      };
      session.results.push(result);
      // Keep the in-memory replay window bounded during an unbounded search.
      if (session.results.length > 2_000) session.results.splice(0, session.results.length - 2_000);

      if (status === "available" && alertable) {
        session.found++;
        foundTags.push(gt);
        appendResultToFile(gt);
        saveState(session.sessionId, session.label, foundTags);
        // Do not await the alert: a slow Discord endpoint must never pause
        // Xbox checking or reduce the configured worker rate.
        void notifyDiscordWebhook(result, session.label, session.sessionId);
      }

      pushActivity({
        username: gt,
        platform: "xbox",
        format: session.label,
        status: status === "available" ? "available" : status === "taken" ? "taken" : "unknown",
        alertable,
        policy: policy?.status,
        sessionId: session.sessionId,
      });

      const cps = computeCps(session);
      broadcastSSE(session, "result", { ...result, cps, attempts: session.attempts, found: session.found });

      // Pace to target CPS
      const elapsed   = Date.now() - checkStart;
      const remaining = minIntervalMs - elapsed;
      if (remaining > 0) await sleep(remaining);
    }
  }

  // Launch workers with a small stagger (10 ms apart) to spread initial burst.
  await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      sleep(i * 10).then(() => worker()),
    ),
  );

  // An infinite search only leaves this runner when the user cancels it or
  // the process aborts. A finite source (a list or a fixed pattern) completes
  // once every name has been checked.
  if (session.exhausted && session.state === "running") session.state = "completed";
  broadcastSSE(session, "done", {
    found:    session.found,
    attempts: session.attempts,
    state:    session.state,
  });

  for (const client of session.sseClients) {
    try { client.end(); } catch { /* ignore */ }
  }
  session.sseClients = [];
}

// ─── Verify single tag ────────────────────────────────────────────────────────

async function verifyGamertag(
  gt: string,
): Promise<{ status: ResultStatus; confidence: "high" | "medium" | "low" }> {
  if (isBlockedByContentFilter(gt)) {
    return { status: "inappropriate", confidence: "high" };
  }
  try {
    const authHeader = await getAuthHeader();

    // 1. Authenticated availability endpoint (high confidence)
    if (authHeader) {
      const result = await checkViaAvailabilityEndpoint(gt, authHeader, AbortSignal.timeout(15_000));
      if (result !== null) return { status: result, confidence: "high" };
    }

    // 2. CDN fallback (medium confidence)
    const cdnResult = await checkViaCDN(gt, AbortSignal.timeout(10_000));
    if (cdnResult !== null) return { status: cdnResult, confidence: authHeader ? "medium" : "low" };

    return { status: "error", confidence: "low" };
  } catch {
    return { status: "error", confidence: "low" };
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Verify single tag
router.get("/gamertag/verify/:tag", async (req, res): Promise<void> => {
  const tag = Array.isArray(req.params.tag) ? req.params.tag[0] : req.params.tag;
  const validation = validateXboxGamertag(tag);
  if (!validation.valid) {
    res.status(400).json({ error: validation.errors[0], errors: validation.errors }); return;
  }
  req.log.info({ tag }, "Verifying gamertag");
  const { status, confidence } = await verifyGamertag(tag);
  res.json({ gamertag: tag, status, confidence });
});

// Validate gamertags with the shared server-side rules (single source of truth).
router.post("/gamertag/validate", (req, res): void => {
  const names = (req.body as { usernames?: unknown } | undefined)?.usernames;
  if (!Array.isArray(names) || names.length === 0 || names.length > 500) {
    res.status(400).json({ error: "usernames must be a list of 1 to 500 entries." });
    return;
  }
  res.json({ results: names.map((n) => validateXboxGamertag(n)) });
});

// Validate a generation config without starting a search.
router.post("/gamertag/config/validate", (req, res): void => {
  const config = (req.body as { config?: unknown } | undefined)?.config;
  const outcome = compileGeneration(config);
  res.json({ valid: outcome.ok, errors: outcome.errors, label: outcome.label, info: outcome.info });
});

// Start search
router.post("/gamertag/search", async (req, res): Promise<void> => {
  const parsed = StartGamertagSearchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message }); return;
  }

  const { config, rate, runEthanPolicyCheck } = parsed.data;
  if (!Number.isFinite(rate) || rate < 1 || rate > 1_000) {
    res.status(400).json({ error: "Rate must be between 1 and 1000 checks per second." });
    return;
  }

  // The server is the only authority on whether a configuration is usable.
  const compiled = compileGeneration(config);
  if (!compiled.ok || !compiled.create) {
    res.status(400).json({ error: compiled.errors[0] ?? "Invalid configuration.", errors: compiled.errors });
    return;
  }

  const sessionId = crypto.randomUUID();
  const abort     = new AbortController();

  const session: Session = {
    sessionId,
    mode:          config.mode,
    label:         compiled.label,
    generator:     compiled.create(),
    exhausted:     false,
    rate:          Math.round(rate),
    runEthanPolicyCheck: runEthanPolicyCheck ?? false,
    state:         "running",
    paused:        false,
    attempts:      0,
    found:         0,
    taken:         0,
    unknown:       0,
    results:       [],
    abort,
    sseClients:    [],
    recentCheckTs: [],
  };

  sessions.set(sessionId, session);
  req.log.info({ sessionId, mode: config.mode, rate, runEthanPolicyCheck }, "Starting gamertag search");

  runSearch(session).catch((err) => logger.error({ err, sessionId }, "Search error"));

  res.status(201).json(
    StartGamertagSearchResponse.parse({
      sessionId: session.sessionId,
      mode:      session.mode,
      label:     session.label,
      rate:      session.rate,
      state:     session.state,
      attempts:  session.attempts,
      found:     session.found,
      results:   session.results,
    }),
  );
});

// Get session
router.get("/gamertag/sessions/:sessionId", async (req, res): Promise<void> => {
  const params = GetGamertagSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message }); return;
  }
  const session = sessions.get(params.data.sessionId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  res.json({
    ...GetGamertagSessionResponse.parse({
      sessionId: session.sessionId,
      mode:      session.mode,
      label:     session.label,
      rate:      session.rate,
      state:     session.state,
      attempts:  session.attempts,
      found:     session.found,
      taken:     session.taken,
      unknown:   session.unknown,
      paused:    session.paused,
      results:   session.results,
    }),
    paused: session.paused,
    cps:    computeCps(session),
  });
});

// Cancel session
router.delete("/gamertag/sessions/:sessionId", async (req, res): Promise<void> => {
  const params = CancelGamertagSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message }); return;
  }
  const session = sessions.get(params.data.sessionId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  session.state = "cancelled";
  session.paused = false;
  session.abort.abort();
  req.log.info({ sessionId: params.data.sessionId }, "Cancelled gamertag search");

  res.json(
    CancelGamertagSessionResponse.parse({
      sessionId: session.sessionId,
      mode:      session.mode,
      label:     session.label,
      rate:      session.rate,
      state:     session.state,
      attempts:  session.attempts,
      found:     session.found,
      results:   session.results,
    }),
  );
});

// Pause session
router.post("/gamertag/sessions/:sessionId/pause", (req, res): void => {
  const rawId = Array.isArray(req.params.sessionId)
    ? req.params.sessionId[0]
    : req.params.sessionId;
  const session = sessions.get(rawId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  if (session.state !== "running") {
    res.status(400).json({ error: "Session is not running" }); return;
  }
  session.paused = true;
  req.log.info({ sessionId: rawId }, "Paused gamertag search");
  res.json({ sessionId: rawId, paused: true });
});

// Resume session
router.post("/gamertag/sessions/:sessionId/resume", (req, res): void => {
  const rawId = Array.isArray(req.params.sessionId)
    ? req.params.sessionId[0]
    : req.params.sessionId;
  const session = sessions.get(rawId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  if (session.state !== "running") {
    res.status(400).json({ error: "Session is not running" }); return;
  }
  session.paused = false;
  req.log.info({ sessionId: rawId }, "Resumed gamertag search");
  res.json({ sessionId: rawId, paused: false });
});

// Claim a gamertag using the server's authenticated Xbox session.
// No manual token input needed — the device code auth flow provides it.
//
// IMPORTANT: We never accept a claim where Xbox silently assigned a suffix
// (e.g. "MyTag" → "MyTag1234"). We compare the returned gamertag against
// the requested one and reject any mismatch to prevent the user from
// accidentally claiming a suffixed tag.
router.post("/gamertag/claim", async (req, res): Promise<void> => {
  const { gamertag } = req.body as { gamertag?: string };

  if (!gamertag) {
    res.status(400).json({ error: "gamertag is required" });
    return;
  }
  const validation = validateXboxGamertag(gamertag);
  if (!validation.valid) {
    res.status(400).json({
      success: false, gamertag, error: "invalid_gamertag", message: validation.errors.join(" "),
    });
    return;
  }

  // Only one claim per gamertag can be in flight; a double click or a retry
  // must never send a second request to Xbox.
  const claimKey = gamertag.toUpperCase();
  if (claimsInFlight.has(claimKey)) {
    res.status(409).json({
      success: false, gamertag, error: "claim_in_progress", message: "A claim for this gamertag is already in progress.",
    });
    return;
  }
  claimsInFlight.add(claimKey);
  const releaseClaim = (): void => { claimsInFlight.delete(claimKey); };
  res.once("finish", releaseClaim);
  res.once("close", releaseClaim);

  // Use the gamertag.xboxlive.com-scoped XSTS token for claims.
  // The general http://xboxlive.com token does NOT work for name changes.
  const authHeader = await getClaimAuthHeader();
  if (!authHeader) {
    res.status(401).json({
      success: false,
      gamertag,
      error: "auth_required",
      message: "Not authenticated with Xbox. Click 'Sign in to Xbox' and complete the device code flow first.",
    });
    return;
  }

  const xuid = getXuid();

  // ── Pre-check: confirm no suffix before firing the claim PUT ─────────────
  // Call the availability endpoint first. If Xbox indicates hasSuffix: true,
  // or the tag is no longer available, abort immediately so we never claim a
  // suffixed tag by accident.
  const preCheckHeader = await getAuthHeader();
  if (preCheckHeader) {
    try {
      const availRes = await fetch(
        `https://gamertag.xboxlive.com/gamertags/${encodeURIComponent(gamertag)}/availability`,
        {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization:            preCheckHeader,
            "x-xbl-contract-version": "1",
            Accept:                   "application/json",
            "Accept-Language":        "en-US",
          },
        },
      );
      if (availRes.ok) {
        const availData = (await availRes.json()) as {
          isAvailable?: boolean;
          hasSuffix?:   boolean;
          suggestedGamertag?: string;
        };
        if (availData.hasSuffix === true) {
          req.log.warn({ gamertag, suggested: availData.suggestedGamertag }, "Pre-check: hasSuffix=true — refusing claim");
          res.status(409).json({
            success: false,
            gamertag,
            error:   "suffix_required",
            message: `"${gamertag}" is no longer freely available — Xbox would assign a suffix (e.g. "${availData.suggestedGamertag ?? gamertag + "#1234"}"). Claim aborted.`,
          });
          return;
        }
        if (availData.isAvailable === false) {
          req.log.warn({ gamertag }, "Pre-check: isAvailable=false — refusing claim");
          res.status(409).json({
            success: false,
            gamertag,
            error:   "taken",
            message: `"${gamertag}" is no longer available. Someone else may have claimed it just now.`,
          });
          return;
        }
      }
    } catch (preCheckErr) {
      // Non-critical — log and proceed; the PUT itself will catch any issues.
      req.log.warn({ err: String(preCheckErr) }, "Pre-check availability fetch failed — proceeding with claim attempt");
    }
  }

  // Helper — parse claim response and reject if Xbox assigned a suffix.
  // Uses contract v2 for the /current endpoint, v1 for legacy paths.
  async function attemptClaim(url: string): Promise<{ status: number; body: string }> {
    const contractVersion = url.endsWith("/current") ? "2" : "1";
    const r = await fetch(url, {
      method:  "PUT",
      signal:  AbortSignal.timeout(15_000),
      headers: {
        Authorization:            authHeader!,
        "Content-Type":           "application/json",
        "x-xbl-contract-version": contractVersion,
        Accept:                   "application/json",
        "Accept-Language":        "en-US",
      },
      body: JSON.stringify({ gamertag }),
    });
    const body = await r.text().catch(() => "");
    return { status: r.status, body };
  }

  try {
    // Xbox gamertag change endpoint — try multiple URL formats in order.
    //
    // Format 1: PUT /users/xuid({xuid})/gamertags/current  (contract v2)
    //   The "current" endpoint is the standard Xbox Live gamertag change API.
    //   The desired tag is passed in the JSON body.
    //
    // Format 2: PUT /users/xuid({xuid})/gamertags/{tag}    (contract v1, legacy)
    //   Older format observed in Xbox app traffic — still works on some accounts.
    //
    // Format 3: PUT /gamertags/{tag}                        (no-XUID fallback)
    //   Used when XUID is unavailable.
    const urls: string[] = xuid
      ? [
          `https://gamertag.xboxlive.com/users/xuid(${xuid})/gamertags/current`,
          `https://gamertag.xboxlive.com/users/xuid(${xuid})/gamertags/${encodeURIComponent(gamertag)}`,
          `https://gamertag.xboxlive.com/gamertags/${encodeURIComponent(gamertag)}`,
        ]
      : [`https://gamertag.xboxlive.com/gamertags/${encodeURIComponent(gamertag)}`];

    let lastStatus = 0;
    let lastBody   = "";

    for (const url of urls) {
      const { status, body } = await attemptClaim(url);
      req.log.info({ gamertag, status, url }, "Gamertag claim attempt");
      lastStatus = status;
      lastBody   = body;

      if (status === 200 || status === 201) {
        // Parse response — check if Xbox silently applied a suffix
        let assignedTag: string | undefined;
        try {
          const data = JSON.parse(body) as { gamertag?: string; Gamertag?: string };
          assignedTag = data.gamertag ?? data.Gamertag;
        } catch { /* no body / non-JSON — assume exact match */ }

        if (assignedTag && assignedTag.toUpperCase() !== gamertag.toUpperCase()) {
          // Xbox assigned a different (suffixed) tag — refuse the claim
          req.log.warn({ requested: gamertag, assigned: assignedTag }, "Xbox returned a suffixed gamertag — rejecting");
          res.status(409).json({
            success: false,
            gamertag,
            error: "suffix_assigned",
            message: `Xbox tried to assign "${assignedTag}" instead of "${gamertag}" (suffix added). Claim rejected — the exact tag is not available.`,
          });
          return;
        }

        res.json({ success: true, gamertag, message: "Gamertag claimed successfully!" });
        return;
      }

      // 429 rate-limit — no point retrying the second URL
      if (status === 429) break;
      // Auth errors are terminal
      if (status === 401 || status === 403) break;
    }

    // Handle final status. A missing XUID is called out because Xbox may
    // require it for the claim endpoint; the message tells the user how to fix it.
    const xuidHint = xuid
      ? ""
      : " No XUID was resolved for this account, which Xbox may require. Reconnect Xbox and try again.";

    if (lastStatus === 429) {
      res.status(429).json({
        success: false, gamertag, error: "rate_limited",
        message: "Xbox is rate-limiting claims. Try again in a moment.",
      });
      return;
    }
    if (lastStatus === 401 || lastStatus === 403) {
      res.status(401).json({
        success: false, gamertag, error: "auth_failed",
        message: `Xbox auth token expired or was refused. Reconnect Xbox.${xuidHint}`,
      });
      return;
    }
    if (lastStatus === 400) {
      res.status(400).json({
        success: false, gamertag, error: "rejected",
        message: `Xbox rejected the claim. The tag may have just been taken or is reserved.${xuidHint}`,
        detail: lastBody.slice(0, 300),
      });
      return;
    }
    if (lastStatus === 409 || lastStatus === 412 || lastStatus === 422) {
      res.status(409).json({
        success: false, gamertag, error: "rejected",
        message: "Xbox refused the claim (conflict). The tag was probably just taken or is not allowed.",
        detail: lastBody.slice(0, 300),
      });
      return;
    }
    if (lastStatus === 404) {
      res.status(404).json({
        success: false, gamertag, error: "not_found",
        message: `"${gamertag}" doesn't exist as a claimable tag on Xbox — it may be reserved, permanently unavailable, or already owned by a system account. Try a different tag.`,
      });
      return;
    }

    res.status(lastStatus || 500).json({
      success: false, gamertag, error: "xbox_error",
      message: `Xbox returned HTTP ${lastStatus}.`,
      detail: lastBody.slice(0, 300),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      success: false, gamertag, error: "network_error",
      message: `Network error during claim: ${msg}`,
    });
  }
});

// SSE stream
router.get("/gamertag/sessions/:sessionId/stream", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.sessionId)
    ? req.params.sessionId[0]
    : req.params.sessionId;

  const session = sessions.get(rawId);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  session.sseClients.push(res);

  // Replay already-collected results for late subscribers
  for (const result of session.results) {
    res.write(`event: result\ndata: ${JSON.stringify({
      ...result,
      cps:      computeCps(session),
      attempts: session.attempts,
      found:    session.found,
    })}\n\n`);
  }

  if (session.state !== "running") {
    res.write(
      `event: done\ndata: ${JSON.stringify({ found: session.found, attempts: session.attempts, state: session.state })}\n\n`,
    );
    res.end();
    return;
  }

  req.on("close", () => {
    session.sseClients = session.sseClients.filter((c) => c !== res);
  });
});

/** Lightweight counters for the system-status endpoint. */
export function getSessionStats(): { running: number; total: number; sseClients: number } {
  let running = 0;
  let sseClients = 0;
  for (const session of sessions.values()) {
    if (session.state === "running") running++;
    sseClients += session.sseClients.length;
  }
  return { running, total: sessions.size, sseClients };
}

export default router;

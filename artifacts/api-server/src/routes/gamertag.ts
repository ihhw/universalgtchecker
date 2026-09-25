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
import { getAuthHeader } from "../lib/xbox-auth";
import {
  checkGamertag, checkViaAvailabilityEndpoint, checkViaCDN, runEthanPolicyCheck,
  type PolicyStatus, type ResultStatus,
} from "../lib/xbox-availability";
import { claimGamertag, listClaims, notifyClaimWebhook, probeGamertagReservation, type ClaimRecord } from "../lib/xbox-claim";
import { compileGeneration, type Generator } from "../lib/gamertag-generator";
import { validateXboxGamertag } from "../lib/xbox-validation";
import { pushActivity } from "../lib/activity";
import { getWebhookTarget, sendWebhookPayload } from "../lib/webhook-store";

const router: IRouter = Router();

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
  /**
   * Server-side auto-claim. Claims only alertable hits, one at a time, and
   * switches itself off after the first Xbox-confirmed claim so the account
   * is never renamed twice by one search.
   */
  autoClaim:     boolean;
  /** Gamertag this session successfully claimed, once Xbox confirmed it. */
  claimed:       string | null;
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

// Auto-save paths
const RESULTS_FILE = path.join(process.cwd(), "results.txt");
const STATE_FILE   = path.join(process.cwd(), "state.json");
// Persistent deduplication: once an available tag has been emitted, it is
// never emitted as available again, including after a server restart.
const shownAvailable = new Set<string>();

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
        } else if (status === "available") {
          // Re-verify before treating this as a real hit. A single primary
          // check can't tell a genuine hit apart from a transient false
          // positive (CDN cache timing, a stray network hiccup) — a second
          // check a moment later can. This only runs on an actual hit, so it
          // costs nothing on the vast majority of checks that come back
          // taken.
          const reverifySignal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
          let reverify: ResultStatus;
          try {
            reverify = await checkGamertag(gt, reverifySignal);
          } catch {
            reverify = "error";
          }
          if (reverify !== "available") {
            status = reverify === "taken" ? "taken" : "unknown";
          } else {
            if (session.runEthanPolicyCheck) {
              // The policy endpoint may need its own 5-second 429 backoff, so it
              // gets a fresh budget instead of inheriting the primary check's
              // already-running 5-second timeout.
              const policySignal = AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(20_000),
              ]);
              const policyResult = await runEthanPolicyCheck(gt, policySignal, { fast: true });
              policy = { status: policyResult.status, message: policyResult.message };
              // An available result is only alertable after Ethan approves it.
              // Auth, rate-limit, and network failures must not bypass the
              // secondary check and accidentally send an unverified tag.
              if (policyResult.status !== "approved") {
                status = "unknown";
              }
            }
            // The reserve probe answers a different question than either the
            // primary CDN check or the optional Double Check policy check:
            // will Xbox actually grant the EXACT typed classic gamertag, or
            // only a suffixed variant. Neither of those checks reliably
            // carries that info (real testing found policy-approved hits
            // still needing a suffix), so this always runs on a surviving
            // hit -- with or without Double Check enabled -- since without
            // it, "available" hits showed a suffix at essentially the same
            // rate as with Double Check on.
            if (status === "available") {
              const probeResult = await probeGamertagReservation(gt);
              if (probeResult.status !== "available") {
                status = "unknown";
                policy = {
                  status: "unavailable",
                  message: probeResult.message ?? "Xbox would only reserve this gamertag with a suffix attached.",
                };
              }
            }
          }
        }
        // Final alert state. Only a strict primary "available" that is either
        // not double-checked or explicitly policy-approved is alertable. The
        // reserve probe above already downgrades a suffix-only offer to
        // "unknown", so a surviving "available" here has passed it too.
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
        // Claim straight from the worker: no browser round trip, so it works
        // with the tab closed and starts the moment the hit is confirmed.
        if (session.autoClaim) void autoClaimHit(session, gt);
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

const PREVIEW_SAMPLES = 8;
const PREVIEW_DRAWS = 40; // draws attempted to fill PREVIEW_SAMPLES with unique names

/** A handful of example names the current settings could produce, for a live preview. */
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

// Validate a generation config without starting a search.
router.post("/gamertag/config/validate", (req, res): void => {
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

// Start search
router.post("/gamertag/search", async (req, res): Promise<void> => {
  const parsed = StartGamertagSearchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message }); return;
  }

  const { config, rate, runEthanPolicyCheck, autoClaim } = parsed.data;
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
    autoClaim:     autoClaim ?? false,
    claimed:       null,
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
  req.log.info({ sessionId, mode: config.mode, rate, runEthanPolicyCheck, autoClaim }, "Starting gamertag search");

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
    autoClaim: session.autoClaim,
    claimed:   session.claimed,
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

// ─── Claim ────────────────────────────────────────────────────────────────────
//
// Every claim (this route, checker auto-claim, the sniper, the Discord bot)
// goes through lib/xbox-claim.ts, which reserves then changes the gamertag
// with the active account's XSTS token + XUID and reports `claimed` ONLY when
// Xbox confirms the exact gamertag.

const CLAIM_HTTP: Record<ClaimRecord["state"], number> = {
  claiming: 202,
  claimed: 200,
  claim_failed: 409,
  auth_error: 401,
  rate_limited: 429,
  network_error: 502,
  unknown: 502,
};

/** Response shape kept compatible with the Discord bot and older clients. */
function claimResponse(r: ClaimRecord) {
  return {
    success: r.state === "claimed",
    gamertag: r.gamertag,
    state: r.state,
    error: r.state === "claimed" ? undefined : (r.errorCode ?? r.state),
    message: r.state === "claimed"
      ? `Claimed ${r.gamertag} — confirmed by Xbox (${r.confirmedBy === "change_response" ? "change response" : "account identity"}).`
      : (r.reason ?? "The claim was not confirmed."),
    httpStatus: r.httpStatus,
    step: r.step,
    confirmedBy: r.confirmedBy,
    latency: r.latency,
    claim: r,
  };
}

async function autoClaimHit(session: Session, gamertag: string): Promise<void> {
  if (!session.autoClaim || session.claimed) return;
  const r = await claimGamertag(gamertag, { source: "checker", sessionId: session.sessionId });
  if (r.state === "claimed") {
    session.claimed = r.gamertag;
    session.autoClaim = false;
    logger.info({ sessionId: session.sessionId, gamertag }, "Auto-claim confirmed; auto-claim disabled for this search");
  }
  if (r.errorCode !== "claim_in_progress") void notifyClaimWebhook(r, "Xbox Auto Claim");
  // Nothing about a failed claim can be fixed by retrying against a
  // different account state; stop auto-claiming on auth problems.
  if (r.state === "auth_error") session.autoClaim = false;
  broadcastSSE(session, "claim", r);
}

router.post("/gamertag/claim", async (req, res): Promise<void> => {
  const { gamertag, accountId } = (req.body ?? {}) as { gamertag?: string; accountId?: string };
  if (!gamertag) {
    res.status(400).json({ success: false, error: "gamertag is required", message: "gamertag is required" });
    return;
  }
  const r = await claimGamertag(gamertag, { source: "manual", accountId: typeof accountId === "string" ? accountId : undefined });
  const status = r.errorCode === "invalid_gamertag" ? 400 : CLAIM_HTTP[r.state];
  res.status(status).json(claimResponse(r));
});

/** Recent claim records (backend is the source of truth for claim state). */
router.get("/gamertag/claims", (req, res): void => {
  const after = Number(req.query["after"] ?? 0);
  res.json({ claims: listClaims(Number.isFinite(after) ? after : 0) });
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

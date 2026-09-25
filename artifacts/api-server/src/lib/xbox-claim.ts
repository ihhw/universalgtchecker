/**
 * Gamertag claim engine — the single path every claim takes (manual claim
 * button, Checker auto-claim, Sniper, Discord bot).
 *
 * Flow (all requests authorized with the active account's http://xboxlive.com
 * XSTS token and its XUID):
 *   1. POST gamertag.xboxlive.com/gamertags/reserve
 *        { classicGamertag, reservationId: <xuid>, targetGamertagFields: "classicGamertag" }
 *      Reserves the exact name for this account. 409 = taken/reserved elsewhere.
 *      CONFIRMED against live Xbox: this call succeeds (accepts the reservation).
 *   2. POST accounts.xboxlive.com/users/current/profile/gamertag
 *        { Gamertag, PreviewOnly: false, ReservationId: <xuid> }, x-xbl-contract-version: 3
 *      Performs the change using that reservation.
 *      CONFIRMED against live Xbox: this is the right URL and method. Xbox
 *      returns real business-logic responses from it (e.g. HTTP 400 with a
 *      structured { code, description } body), not routing errors.
 *      The success (200, actually-applied) response has NOT yet been
 *      confirmed live — see .agents/memory/gamertag-autoclaim.md for the
 *      current state of that investigation before changing this body again.
 *
 * A result is CLAIMED only when Xbox confirms it: either the change response
 * names exactly the requested gamertag with no suffix, or (when the response
 * has no usable body / the outcome is uncertain) a freshly issued XSTS token
 * reports the requested gamertag for this account. Sending a request is never
 * treated as success.
 *
 * NOTE: these are the endpoints Xbox's own apps use for gamertag changes, per
 * reverse-engineered Xbox Live traffic; they are not officially documented by
 * Microsoft and may change. Ruled out by real testing before landing on the
 * URL/method/body above (see .agents/memory/gamertag-autoclaim.md for the
 * full history and exact error bodies):
 *   - PUT gamertag.xboxlive.com/users/xuid(<xuid>)/gamertag        → HTTP 404
 *   - PUT accounts.xboxlive.com/users/current/profile/gamertag     → HTTP 405
 *   - POST .../gamertag, lowercase body, no ReservationId          → HTTP 400
 *     code 1372 "belongs to another user", on every tested string
 *   - POST .../gamertag, lowercase body + ReservationId            → HTTP 200
 *     but body {"hasFree":true} with no gamertag confirmation, and the
 *     account's own identity afterward showed the change did NOT apply —
 *     reads as an eligibility/preview answer, not a performed write
 * A 405 response still surfaces Xbox's Allow header verbatim (kept as
 * defence in depth in case Xbox's accepted method ever changes again).
 */

import fs from "fs";
import path from "path";
import { logger } from "./logger";
import { validateXboxGamertag } from "./xbox-validation";
import { getClaimContext, refreshActiveIdentity, getActiveAccountId, getAccountInfoList } from "./xbox-auth";
import { fastFetch, retryAfterMs, warmConnection } from "./xbox-http";
import { getWebhookTarget, sendWebhookPayload } from "./webhook-store";
import { recordClaim } from "./stats";
import { logAudit } from "./audit";

/**
 * Every reservation-probe response, raw and untruncated, appended here —
 * always on, no LOG_LEVEL flag to remember to set. Repeated attempts to fix
 * suffix detection from a single captured example kept guessing wrong about
 * what a genuinely-available response looks like (this file exists because
 * a "confirmed available" hit still turned out to need a suffix even after
 * matching the one real captured example known at the time). Contains only
 * gamertags and Xbox's own response bodies — no tokens, no account secrets.
 */
const PROBE_LOG_FILE = path.join(process.cwd(), "probe-debug.log");
function logProbeDiagnostic(entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(PROBE_LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* best-effort; never let logging break a probe */ }
}

const GAMERTAG_HOST = "https://gamertag.xboxlive.com";
const RESERVE_URL   = `${GAMERTAG_HOST}/gamertags/reserve`;

/**
 * Spacing between reservation-probe requests, tracked per account — mirrors
 * the Double Check policy endpoint's own adaptive spacing in
 * xbox-availability.ts (same class of endpoint, gamertag.xboxlive.com).
 *
 * The probe used to fire one reserve call per hit with no throttling of its
 * own at all. Under bulk concurrent checking, that meant every worker that
 * hit "available" fired a reserve call immediately, all converging on the
 * SAME account (probes don't mark an account busy, so automatic selection
 * kept picking the same free one) — a burst far beyond what this endpoint
 * can sustain, producing widespread 429s that got reported back as
 * "unknown" en masse. Serializing per-account with adaptive spacing (plus a
 * retry instead of giving up on the first 429) fixes that.
 */
const PROBE_SPACING_FLOOR_MS = 350;
const PROBE_SPACING_CAP_MS = 8_000;
const PROBE_RELAX_AFTER_OK = 5;

/**
 * Ceiling on how many probe calls may be queued for one account at once.
 *
 * This used to be a tight cap (8) to protect search workers that AWAITED
 * the probe inline — a deep queue meant a worker could sit blocked for
 * minutes, and enough of those piling up froze the whole search. That
 * inline-await design is gone (see routes/gamertag.ts: a hit is recorded
 * provisionally and confirmed in the background, never blocking the search
 * loop), so a deep probe queue no longer blocks anything user-visible — it
 * just means confirmations trickle in slower under heavy load. A low cap
 * NOW only meant most hits gave up on ever being confirmed at all: with
 * checking fast enough to produce hits quicker than one account can
 * confirm them (every 350ms-8s), the queue stayed permanently full and
 * nearly everything after the first few hits was rejected outright,
 * forever stuck as an unexplained "unknown" even for names later confirmed
 * by hand to be genuinely available.
 *
 * This is now just a safety valve against unbounded memory growth on a
 * truly pathological run, not a normal-operation limit.
 */
const PROBE_QUEUE_DEPTH_CAP = 5_000;

interface AccountProbeState {
  spacingMs: number;
  consecutiveOk: number;
  lastRequestAt: number;
  queue: Promise<void>;
  queueDepth: number;
}
const probeStateByAccount = new Map<string, AccountProbeState>();

function probeStateFor(accountId: string): AccountProbeState {
  let state = probeStateByAccount.get(accountId);
  if (!state) {
    state = { spacingMs: PROBE_SPACING_FLOOR_MS, consecutiveOk: 0, lastRequestAt: 0, queue: Promise.resolve(), queueDepth: 0 };
    probeStateByAccount.set(accountId, state);
  }
  return state;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function raiseProbeSpacing(accountId: string, ms: number): void {
  const state = probeStateFor(accountId);
  state.spacingMs = Math.min(PROBE_SPACING_CAP_MS, Math.max(state.spacingMs, ms));
  state.consecutiveOk = 0;
}

function noteProbeOk(accountId: string): void {
  const state = probeStateFor(accountId);
  if (state.spacingMs <= PROBE_SPACING_FLOOR_MS) return;
  state.consecutiveOk++;
  if (state.consecutiveOk >= PROBE_RELAX_AFTER_OK) {
    state.spacingMs = Math.max(PROBE_SPACING_FLOOR_MS, Math.round(state.spacingMs * 0.7));
    state.consecutiveOk = 0;
  }
}

class ProbeQueueFullError extends Error {}

function waitForProbeSlot(accountId: string, signal?: AbortSignal): Promise<void> {
  const state = probeStateFor(accountId);
  if (state.queueDepth >= PROBE_QUEUE_DEPTH_CAP) {
    return Promise.reject(new ProbeQueueFullError("Reservation probe queue is full for this account."));
  }
  state.queueDepth++;
  const acquire = state.queue.then(async () => {
    const delay = Math.max(0, state.spacingMs - (Date.now() - state.lastRequestAt));
    if (delay > 0) await wait(delay, signal);
    if (!signal?.aborted) state.lastRequestAt = Date.now();
  });
  state.queue = acquire.catch(() => undefined).finally(() => { state.queueDepth--; });
  return acquire;
}
// Confirmed against live Xbox: gamertag.xboxlive.com/users/xuid(<xuid>)/gamertag
// does not exist (HTTP 404). This is the endpoint Xbox's own apps use for the
// change step, per reverse-engineered Xbox Live traffic (OpenXbox xbox-webapi
// and related community write-ups). Still unverified against live Xbox as of
// this change — the next real attempt is the actual test.
const CHANGE_URL = "https://accounts.xboxlive.com/users/current/profile/gamertag";
// Overridable only so tests can exercise timeouts quickly.
const RESERVE_TIMEOUT_MS = Number(process.env["XBOX_RESERVE_TIMEOUT_MS"]) || 10_000;
const CHANGE_TIMEOUT_MS  = Number(process.env["XBOX_CHANGE_TIMEOUT_MS"]) || 15_000;

export type ClaimState =
  | "claiming"
  | "claimed"
  | "claim_failed"
  | "auth_error"
  | "rate_limited"
  | "network_error"
  | "unknown";

/** Machine-readable reason, kept compatible with the previous claim API's `error` values. */
export type ClaimErrorCode =
  | "invalid_gamertag"
  | "claim_in_progress"
  | "auth_required"
  | "auth_failed"
  | "taken"
  | "suffix_required"
  | "suffix_assigned"
  | "rejected"
  | "not_allowed"
  | "not_found"
  | "rate_limited"
  | "xbox_error"
  | "network_error"
  | "timeout"
  | "unconfirmed";

export type ClaimSource = "manual" | "checker" | "sniper";

export interface ClaimRecord {
  id:          number;
  gamertag:    string;
  source:      ClaimSource;
  sessionId?:  string;
  /** Which Xbox account performed this claim (internal id, never a token). */
  accountId:   string | null;
  state:       ClaimState;
  errorCode:   ClaimErrorCode | null;
  /** Human-readable explanation, including what Xbox said. */
  reason:      string | null;
  /** Step that produced the final outcome. */
  step:        "validate" | "auth" | "reserve" | "change" | "confirm" | null;
  httpStatus:  number | null;
  /** Truncated Xbox response body (never contains credentials). */
  xboxResponse: string | null;
  /** Gamertag Xbox reported after the change, when it reported one. */
  assignedGamertag: string | null;
  confirmedBy: "change_response" | "xsts_identity" | null;
  retryAfterMs?: number;
  startedAt:   number;
  finishedAt:  number | null;
  latency: {
    authMs:    number | null;
    reserveMs: number | null;
    changeMs:  number | null;
    confirmMs: number | null;
    /** Start of the claim → final Xbox answer. */
    totalMs:   number | null;
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const MAX_RECORDS = 200;
const records: ClaimRecord[] = [];
let nextId = 1;
type Listener = (r: ClaimRecord) => void;
const listeners = new Set<Listener>();

export function onClaimUpdate(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function publish(r: ClaimRecord): void {
  for (const fn of listeners) {
    try { fn(r); } catch { /* a listener must never break a claim */ }
  }
}

export function listClaims(afterId = 0): ClaimRecord[] {
  return records.filter((r) => r.id > afterId || r.finishedAt === null);
}

// Only one claim may run at a time PER ACCOUNT: a successful claim renames
// that account, so two concurrent claims on the same account could rename it
// twice. Different accounts may claim concurrently — each has its own entry.
const busy = new Map<string, string>();
export function claimInProgress(accountId: string): string | null { return busy.get(accountId) ?? null; }

/**
 * Round-robins the reservation probe across every connected, non-busy
 * account instead of always using just the active one.
 *
 * The probe's real throughput ceiling is per-account (each can only
 * sustain about one confirmation every 350ms-8s, per PROBE_SPACING_*
 * above) — with a single connected account, that's the hard limit on how
 * fast a batch of hits can ever get confirmed, however high the check
 * rate is. Spreading probes across every connected account (each with its
 * own independent spacing state, since probeStateByAccount is keyed by
 * account id) multiplies that ceiling by however many accounts are
 * connected, instead of queuing everything behind one.
 */
let probeAccountCursor = 0;
function pickProbeAccount(): string | null {
  const all = getAccountInfoList();
  if (all.length === 0) return null;
  for (let i = 0; i < all.length; i++) {
    const idx = (probeAccountCursor + i) % all.length;
    const candidate = all[idx]!;
    if (!busy.has(candidate.id)) {
      probeAccountCursor = idx + 1;
      return candidate.id;
    }
  }
  // Every account is mid-claim: still return one rather than refusing to probe at all.
  const candidate = all[probeAccountCursor % all.length]!;
  probeAccountCursor++;
  return candidate.id;
}

export type AccountSelection = "automatic" | string;

/**
 * Resolves which Xbox account a claim should run as.
 *   - A specific account id: must exist, be READY, and not already claiming.
 *   - "automatic" / undefined: any READY, non-busy account, preferring the
 *     currently active one so single-account setups behave exactly as before.
 * Never silently substitutes a different account for an explicit request,
 * and never picks an account that isn't READY — a claim on a not-ready or
 * already-busy account is a recorded failure, not a silent reassignment.
 */
export type AccountSelectionFailure = { ok: false; kind: "no_account" | "busy"; reason: string };

export function selectAccountForClaim(requested?: AccountSelection): { ok: true; accountId: string } | AccountSelectionFailure {
  const accounts = getAccountInfoList();
  if (accounts.length === 0) return { ok: false, kind: "no_account", reason: "No Xbox account connected. Connect Xbox first." };

  if (requested && requested !== "automatic") {
    const acct = accounts.find((a) => a.id === requested);
    if (!acct) return { ok: false, kind: "no_account", reason: "Selected Xbox account was not found." };
    if (busy.has(acct.id)) {
      return {
        ok: false, kind: "busy",
        reason: `A claim for "${busy.get(acct.id)}" is already in progress on this account. Only one claim per account runs at a time.`,
      };
    }
    // Readiness isn't re-checked here: the cached flag can be stale (e.g.
    // right after a restart, before the first live check), and
    // getClaimContext() immediately after this always re-verifies live and
    // fails closed if the account genuinely isn't usable.
    return { ok: true, accountId: acct.id };
  }

  // Automatic: never pick a busy account. Prefer one already confirmed
  // READY; fall back to an unverified one only when none is — the live
  // check right after this is still the real, fail-closed source of truth.
  const free = accounts.filter((a) => !busy.has(a.id));
  if (free.length === 0) {
    const anyBusyGamertag = [...busy.values()][0];
    return {
      ok: false, kind: "busy",
      reason: `A claim for "${anyBusyGamertag}" is already in progress. Only one claim runs at a time per account, and every connected account is currently claiming.`,
    };
  }
  // Prefer the active account whenever it's free, exactly like the
  // single-account app always behaved — even if it hasn't been live-checked
  // yet (getClaimContext still verifies it for real right after this).
  // Only fall back to a different account when the active one is busy or
  // gone, and among fallbacks prefer one already confirmed READY.
  const activeId = getActiveAccountId();
  const activeCandidate = free.find((a) => a.id === activeId);
  if (activeCandidate) return { ok: true, accountId: activeCandidate.id };
  const ready = free.filter((a) => a.readiness.ready);
  const chosen = ready[0] ?? free[0]!;
  return { ok: true, accountId: chosen.id };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const now = () => performance.now();
const ms = (from: number) => Math.round(now() - from);

function snippet(body: string): string | null {
  const t = body.trim();
  return t ? t.slice(0, 300) : null;
}

/** Pulls a human-readable description out of an Xbox error body, if present. */
function xboxDescription(body: string): string | null {
  try {
    const d = JSON.parse(body) as Record<string, unknown>;
    for (const k of ["description", "Description", "message", "Message", "code", "Code"]) {
      const v = d[k];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
      if (typeof v === "number") return String(v);
    }
  } catch { /* not JSON */ }
  return null;
}

/** Xbox's numeric `code` field on an Accounts-service error body, when present. */
function xboxErrorCode(body: string): number | null {
  try {
    const d = JSON.parse(body) as { code?: unknown };
    return typeof d.code === "number" ? d.code : null;
  } catch {
    return null;
  }
}

// Xbox accounts-service error codes worth a specific, honest explanation
// (confirmed against live Xbox on the accounts.xboxlive.com change endpoint).
const ACCOUNTS_ERROR: Record<number, string> = {
  1372: "This exact gamertag is already the live gamertag of another Xbox account right now. " +
    "The Checker's availability signal (the avatar CDN plus the reserve policy check) can say " +
    "AVAILABLE for a name Xbox's own account system still considers taken — this final claim step " +
    "is the only fully authoritative check. Try a target you've independently confirmed is free.",
  // Seen live as HTTP 403 with `description` literally being a GUID (not text) — a different kind
  // of rejection than 1372, and it fired on multiple different, unrelated target gamertags, so it
  // is not about the specific name. Two honest possibilities, not yet distinguished: (a) this Xbox
  // account has no free gamertag change available right now (checkable in the official Xbox app),
  // or (b) this app's registration is not authorized to perform gamertag changes even though it can
  // sign in and reserve names. Check via the official Xbox app first — it's the cheapest way to
  // tell which.
  5025: "Xbox refused this specific change (code 5025) for a reason unrelated to the target name " +
    "itself — it happened on multiple different, unrelated gamertags in a row. Either this account " +
    "has no free gamertag change available right now, or this app isn't authorized to perform the " +
    "change even though it can sign in and reserve names. Check whether the official Xbox app shows " +
    "a free gamertag change available for this account before trying again here.",
};

function sameTag(a: string | null | undefined, b: string): boolean {
  return typeof a === "string" && a.trim().toUpperCase() === b.trim().toUpperCase();
}

export interface ReserveSuffixInfo {
  /** True when Xbox will only offer this name with a suffix attached (no classic slot free). */
  suffixed: boolean;
  /** The name Xbox actually offered (with suffix if any), for messages. */
  offered?: string;
  suffix?: string;
}

/**
 * Parses gamertag.xboxlive.com/gamertags/reserve's REAL response shape.
 *
 * CONFIRMED against real captured live Xbox traffic (2026-09-25, from
 * account.xbox.com's own gamertag-change page via browser devtools):
 *
 * Real REQUEST (what the official site actually sends when you type a
 * candidate name — NOT what earlier attempts guessed):
 *   {"reservationId":"...","modernGamertag":"Y301","targetGamertagFields":"modernGamertag"}
 *
 * Real RESPONSE, for a name that turned out to need a suffix:
 *   {"promptForClassicGamertag":false,"classicTranslationLevel":"None",
 *    "uniqueModernGamertag":"NP0R#9401","modernGamertagSuffix":"9401",
 *    "modernGamertag":"NP0R","gamertag":"NP0R9401"}
 *
 * Critical realization from the request shape: this call answers "what
 * MODERN gamertag would this become" — so `modernGamertagSuffix` /
 * `uniqueModernGamertag` are populated on essentially EVERY response,
 * suffixed or not, because that's what a modern gamertag inherently is (a
 * base name plus an assigned suffix). Treating their presence as "suffix
 * required" (what the previous fix did) is why that fix false-flagged
 * literally every hit, including names independently confirmed unowned —
 * the field is not a signal, it's just always there.
 *
 * The actual signal for whether a classic (no-suffix) slot exists at all is
 * `promptForClassicGamertag`: true only when Xbox's own UI would offer the
 * user a choice between the classic and modern spelling, i.e. a classic
 * slot is available. `classicTranslationLevel === "None"` corroborates it
 * (also seen "None" on the one confirmed suffix-required capture).
 *
 * Earlier attempts also sent the wrong REQUEST body entirely
 * (`classicGamertag`/`targetGamertagFields: "classicGamertag"`, a guess
 * from the project's claim-flow notes, never actually verified against
 * real traffic) — probeGamertagReservation() below now matches the
 * confirmed real request shape.
 */
export function parseReserveSuffix(body: string, gamertag: string): ReserveSuffixInfo {
  try {
    const r = JSON.parse(body) as {
      promptForClassicGamertag?: boolean;
      classicTranslationLevel?: string;
      modernGamertagSuffix?: string;
      modernGamertag?: string;
      uniqueModernGamertag?: string;
      gamertag?: string;
      classicGamertag?: string;
    };
    if (r.promptForClassicGamertag === true) {
      return { suffixed: false, offered: r.classicGamertag ?? gamertag };
    }
    const suffix = (r.modernGamertagSuffix ?? "").trim();
    return {
      suffixed: true,
      offered: r.uniqueModernGamertag ?? r.gamertag ?? (r.modernGamertag && suffix ? `${r.modernGamertag}#${suffix}` : undefined),
      suffix: suffix || undefined,
    };
  } catch {
    return { suffixed: false };
  }
}

function errorKind(err: unknown): "timeout" | "network" {
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

async function send(
  url: string, authHeader: string, body: unknown, timeoutMs: number,
  opts: { method?: string; contractVersion?: string } = {},
) {
  const res = await fastFetch(url, {
    method: opts.method ?? "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization:            authHeader,
      "Content-Type":           "application/json",
      Accept:                   "application/json",
      "Accept-Language":        "en-US",
      "x-xbl-contract-version": opts.contractVersion ?? "1",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, headers: res.headers, text };
}

// ─── Reservation probe ──────────────────────────────────────────────────────
//
// A non-destructive availability check using ONLY the reserve call (step 1
// of the real claim flow, never the change/commit step). This is the same
// call Xbox's own account.xbox.com gamertag-change page fires live as you
// type a candidate name, before you ever hit Save -- confirmed by capturing
// its real network traffic -- so it's safe to call repeatedly and does not
// commit or hold anything.
//
// Two earlier attempts at this parsed the WRONG response fields
// (classicGamertag/gamertagSuffix, which don't exist) and so never actually
// detected a suffix. parseReserveSuffix() above uses the real fields,
// confirmed from a captured live Xbox response.

export type ReservationProbeStatus =
  | "available" | "taken" | "suffix_required" | "auth_required" | "rate_limited" | "error";

export interface ReservationProbeResult {
  status: ReservationProbeStatus;
  message?: string;
  httpStatus?: number;
}

export async function probeGamertagReservation(
  gamertag: string,
  accountId?: AccountSelection,
  signal?: AbortSignal,
): Promise<ReservationProbeResult> {
  let id: string;
  if (accountId && accountId !== "automatic") {
    // An explicit pin still goes through the normal single-account
    // resolution and its busy check.
    const selection = selectAccountForClaim(accountId);
    if (!selection.ok) {
      logProbeDiagnostic({ gamertag, error: `account selection failed: ${selection.reason}` });
      return { status: selection.kind === "busy" ? "error" : "auth_required", message: selection.reason };
    }
    id = selection.accountId;
  } else {
    const picked = pickProbeAccount();
    if (!picked) {
      logProbeDiagnostic({ gamertag, error: "no Xbox account connected" });
      return { status: "auth_required", message: "No Xbox account connected. Connect Xbox first." };
    }
    id = picked;
  }
  // Never probe an account mid a real claim — a probe's own reserve call
  // could otherwise land in between that claim's reserve and change steps.
  if (claimInProgress(id)) {
    logProbeDiagnostic({ gamertag, accountId: id, error: "account has a claim in progress" });
    return { status: "error", message: "This account has a claim in progress; skipped the probe." };
  }

  const ctx = await getClaimContext(id);
  if (!ctx.ok) {
    logProbeDiagnostic({ gamertag, accountId: id, error: `getClaimContext failed: ${ctx.reason}` });
    return { status: "auth_required", message: ctx.reason };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      try {
        await waitForProbeSlot(id, signal);
      } catch (err) {
        if (err instanceof ProbeQueueFullError) {
          // Fail fast instead of piling onto an already-deep queue — a
          // burst of simultaneous hits degrades to "not probed this time"
          // rather than tying up every search worker waiting its turn.
          return { status: "rate_limited", message: "Too many reservation probes already queued for this account; skipped for now." };
        }
        throw err;
      }
      // Matches the CONFIRMED real request Xbox's own site sends when you
      // type a candidate name (captured live traffic) — not the
      // classicGamertag-targeted guess this used before, which appears to
      // have caused Xbox to always answer with modern-gamertag fields
      // regardless of real classic availability.
      // Real logs show contract-version "1" (the old default here) makes
      // Xbox reject `targetGamertagFields: "modernGamertag"` outright with
      // HTTP 400 / code 1017 "Invalid target gamertag fields" on literally
      // every attempt -- version 1 predates the modern-gamertag field and
      // doesn't recognize it. The confirmed-working change/commit call
      // below already uses version 3; use the same version here so the
      // reserve call is validated against a contract that actually knows
      // about `modernGamertag`.
      const reserve = await send(RESERVE_URL, ctx.authHeader, {
        modernGamertag: gamertag,
        reservationId: ctx.xuid,
        targetGamertagFields: "modernGamertag",
      }, RESERVE_TIMEOUT_MS, { contractVersion: "3" });
      logger.debug({ gamertag, endpoint: "reserve", status: reserve.status, body: snippet(reserve.text) }, "xbox_probe");

      const rs = reserve.status;
      // Log EVERY outcome here, not just a successful 200/201/204 -- a real
      // run showed "available" names being reported as unavailable by this
      // probe with zero entries ever appearing in the success-only log
      // below, meaning every attempt was landing in one of the branches
      // below (429/401/403/409/400/other) without ever being seen. In
      // particular, mapping 400 to "taken" is a carried-over assumption
      // from the OLD classicGamertag-targeted request shape and was never
      // re-verified against the current modernGamertag-targeted one -- it
      // may mean something else entirely now.
      logProbeDiagnostic({ gamertag, accountId: id, httpStatus: rs, rawBody: reserve.text });
      if (rs === 429) {
        const backoffMs = retryAfterMs(reserve.headers, 2_000);
        raiseProbeSpacing(id, backoffMs);
        if (attempt === 0) {
          await wait(backoffMs, signal);
          continue;
        }
        return { status: "rate_limited", httpStatus: rs, message: "Xbox rate-limited the reservation probe." };
      }
      noteProbeOk(id);
      if (rs === 401 || rs === 403) {
        return { status: "auth_required", httpStatus: rs, message: "Xbox rejected this account's authorization for the reservation probe." };
      }
      if (rs === 409) {
        return { status: "taken", httpStatus: rs, message: "Xbox reports this gamertag is taken or reserved by someone else." };
      }
      if (rs === 400) {
        // Distinguish a real "this name is invalid/taken" 400 from a
        // request-validation error on OUR body (e.g. code 1017 "Invalid
        // target gamertag fields", seen on every attempt while the reserve
        // call was sent under the wrong contract version). The latter is a
        // bug in our request, not a real Xbox verdict -- mapping it to
        // "taken" was silently mis-reporting every genuine hit as taken.
        let code: number | undefined;
        try { code = (JSON.parse(reserve.text) as { code?: number }).code; } catch { /* not JSON */ }
        if (code === 1017) {
          return {
            status: "error", httpStatus: rs,
            message: "Xbox rejected the reservation probe's request format (code 1017) -- not a real availability answer.",
          };
        }
        return { status: "taken", httpStatus: rs, message: "Xbox rejected this gamertag." };
      }
      if (rs !== 200 && rs !== 201 && rs !== 204) {
        return { status: "error", httpStatus: rs, message: `Unexpected reservation probe response HTTP ${rs}.` };
      }

      const check = parseReserveSuffix(reserve.text, gamertag);
      // Verdict appended to the same log entry already written above.
      logProbeDiagnostic({ gamertag, accountId: id, httpStatus: rs, verdict: check, followUp: true });
      if (check.suffixed) {
        return {
          status: "suffix_required",
          httpStatus: rs,
          message: `Xbox would only offer "${check.offered ?? gamertag}", not the exact "${gamertag}".`,
        };
      }
      return { status: "available", httpStatus: rs };
    } catch (err) {
      const kind = errorKind(err);
      // If the request itself never got a response (network/timeout/thrown
      // before send() returns), the log call above never ran either. Catch
      // that case here too, so a probe that's failing before ever reaching
      // Xbox is just as visible as one that reaches it and gets rejected.
      logProbeDiagnostic({
        gamertag, accountId: id, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return {
        status: "error",
        message: kind === "timeout" ? "The reservation probe timed out." : "Could not reach Xbox for the reservation probe.",
      };
    }
  }
  return { status: "rate_limited", message: "Xbox rate-limited the reservation probe." };
}

// ─── Claim ────────────────────────────────────────────────────────────────────

export async function claimGamertag(
  rawGamertag: string,
  opts: { source: ClaimSource; sessionId?: string; accountId?: AccountSelection },
): Promise<ClaimRecord> {
  const t0 = now();
  const gamertag = String(rawGamertag ?? "").trim();
  const record: ClaimRecord = {
    id: nextId++, gamertag, source: opts.source, sessionId: opts.sessionId, accountId: null,
    state: "claiming", errorCode: null, reason: null, step: null, httpStatus: null,
    xboxResponse: null, assignedGamertag: null, confirmedBy: null,
    startedAt: Date.now(), finishedAt: null,
    latency: { authMs: null, reserveMs: null, changeMs: null, confirmMs: null, totalMs: null },
  };

  const finish = (
    state: Exclude<ClaimState, "claiming">,
    patch: Partial<ClaimRecord>,
  ): ClaimRecord => {
    Object.assign(record, patch, { state, finishedAt: Date.now() });
    record.latency.totalMs = ms(t0);
    recordClaim(state === "claimed");
    logger.info(
      { gamertag, source: record.source, state, errorCode: record.errorCode, step: record.step, httpStatus: record.httpStatus, totalMs: record.latency.totalMs },
      "Gamertag claim finished",
    );
    publish(record);
    if (state === "claimed") {
      logAudit("CLAIM_CONFIRMED", { gamertag, accountId: record.accountId ?? "", source: record.source });
    } else {
      logAudit("CLAIM_FAILED", { gamertag, accountId: record.accountId ?? "", source: record.source, errorCode: record.errorCode ?? "" });
    }
    // Xbox confirmed the change in its response; refresh the cached identity
    // in the background so the UI shows the account's new gamertag.
    if (state === "claimed" && record.confirmedBy === "change_response") void refreshActiveIdentity(record.accountId ?? undefined).catch(() => undefined);
    return record;
  };

  const validation = validateXboxGamertag(gamertag);
  if (!validation.valid) {
    return finish("claim_failed", { errorCode: "invalid_gamertag", step: "validate", reason: validation.errors.join(" ") });
  }

  const selection = selectAccountForClaim(opts.accountId);
  if (!selection.ok) {
    if (selection.kind === "busy") {
      return finish("claim_failed", { errorCode: "claim_in_progress", step: "validate", reason: selection.reason });
    }
    return finish("auth_error", { errorCode: "auth_required", step: "auth", reason: selection.reason });
  }
  const accountId = selection.accountId;
  record.accountId = accountId;
  busy.set(accountId, gamertag);
  logAudit("ACCOUNT_SELECTED_FOR_CLAIM", { accountId, gamertag, source: record.source });
  logAudit("CLAIM_STARTED", { gamertag, accountId, source: record.source });

  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  publish(record);

  try {
    // ── Auth context: XSTS (http://xboxlive.com) + XUID ────────────────────
    const tAuth = now();
    let ctx = await getClaimContext(accountId);
    record.latency.authMs = ms(tAuth);
    if (!ctx.ok) {
      return finish("auth_error", { errorCode: "auth_required", step: "auth", reason: ctx.reason });
    }

    // ── 1. Reserve ─────────────────────────────────────────────────────────
    const reserveBody = () => ({
      classicGamertag: gamertag,
      reservationId: (ctx as { xuid: string }).xuid,
      targetGamertagFields: "classicGamertag",
    });
    let reserve;
    const tReserve = now();
    try {
      reserve = await send(RESERVE_URL, ctx.authHeader, reserveBody(), RESERVE_TIMEOUT_MS);
      if (reserve.status === 401) {
        // The cached XSTS token was rejected; re-issue it once and retry.
        await refreshActiveIdentity(accountId);
        ctx = await getClaimContext(accountId);
        if (!ctx.ok) {
          record.latency.reserveMs = ms(tReserve);
          return finish("auth_error", { errorCode: "auth_failed", step: "reserve", httpStatus: 401, reason: ctx.reason });
        }
        reserve = await send(RESERVE_URL, ctx.authHeader, reserveBody(), RESERVE_TIMEOUT_MS);
      }
    } catch (err) {
      record.latency.reserveMs = ms(tReserve);
      const kind = errorKind(err);
      return finish("network_error", {
        errorCode: kind === "timeout" ? "timeout" : "network_error", step: "reserve",
        reason: kind === "timeout"
          ? `Xbox did not answer the reserve request within ${RESERVE_TIMEOUT_MS / 1000} s. Nothing was changed.`
          : "Could not reach gamertag.xboxlive.com to reserve the gamertag. Nothing was changed.",
      });
    }
    record.latency.reserveMs = ms(tReserve);

    const rs = reserve.status;
    const rBody = reserve.text;
    const rDesc = xboxDescription(rBody);
    const base = { step: "reserve" as const, httpStatus: rs, xboxResponse: snippet(rBody) };

    if (rs === 429) {
      return finish("rate_limited", {
        ...base, errorCode: "rate_limited",
        retryAfterMs: retryAfterMs(reserve.headers, 30_000),
        reason: "Xbox rate-limited the reserve request (HTTP 429). Nothing was changed.",
      });
    }
    if (rs === 401 || rs === 403) {
      return finish("auth_error", {
        ...base, errorCode: "auth_failed",
        reason: `Xbox refused this account's authorization for the reserve request (HTTP ${rs})${rDesc ? `: ${rDesc}` : ""}. Reconnect Xbox.`,
      });
    }
    if (rs === 409) {
      return finish("claim_failed", {
        ...base, errorCode: "taken",
        reason: `Xbox reports "${gamertag}" is taken or reserved by someone else (HTTP 409)${rDesc ? `: ${rDesc}` : ""}.`,
      });
    }
    if (rs === 400) {
      return finish("claim_failed", {
        ...base, errorCode: "rejected",
        reason: `Xbox rejected "${gamertag}" (HTTP 400)${rDesc ? `: ${rDesc}` : " — not allowed or invalid"}.`,
      });
    }
    if (rs === 404) {
      return finish("claim_failed", {
        ...base, errorCode: "not_found",
        reason: `Xbox returned HTTP 404 for the reserve request${rDesc ? `: ${rDesc}` : ""}.`,
      });
    }
    if (rs >= 500) {
      return finish("claim_failed", {
        ...base, errorCode: "xbox_error",
        reason: `Xbox server error on reserve (HTTP ${rs}). Nothing was changed.`,
      });
    }
    if (rs !== 200 && rs !== 201 && rs !== 204) {
      return finish("unknown", {
        ...base, errorCode: "xbox_error",
        reason: `Unexpected reserve response HTTP ${rs}. The claim was not attempted.`,
      });
    }
    // A successful reservation must be for the exact name, with no suffix.
    const reserveSuffix = parseReserveSuffix(rBody, gamertag);
    if (reserveSuffix.suffixed) {
      return finish("claim_failed", {
        ...base, errorCode: "suffix_required",
        reason: `Xbox would only reserve "${reserveSuffix.offered ?? gamertag}", not the exact "${gamertag}". Claim aborted.`,
      });
    }

    // ── 2. Change ──────────────────────────────────────────────────────────
    const tChange = now();
    let change;
    try {
      change = await send(CHANGE_URL, ctx.authHeader, {
        // PascalCase: a lowercase body got a real HTTP 200 back but with body
        // {"hasFree":true} — no gamertag confirmation, and the account's
        // XSTS identity afterward still showed the OLD gamertag. That reads
        // as Xbox answering an eligibility/preview question rather than
        // performing the write, consistent with previewOnly/gamertag not
        // being recognized and silently defaulting. Xbox's other APIs here
        // (XBL/XSTS auth bodies) are all PascalCase, so trying that shape.
        Gamertag: gamertag,
        PreviewOnly: false,
        // Links this change to the reservation from step 1. CONFIRMED useful:
        // the same target that got HTTP 400 "belongs to another user" three
        // times in a row without this field got a real 200 once it was added.
        ReservationId: ctx.xuid,
      }, CHANGE_TIMEOUT_MS, { method: "POST", contractVersion: "3" });
    } catch (err) {
      record.latency.changeMs = ms(tChange);
      // The request may or may not have been applied; ask Xbox.
      const kind = errorKind(err);
      const confirmed = await confirmViaIdentity(record, gamertag, accountId);
      if (confirmed) return finish("claimed", { step: "confirm", errorCode: null, reason: null, confirmedBy: "xsts_identity" });
      return finish(kind === "timeout" ? "unknown" : "network_error", {
        step: "change", errorCode: kind === "timeout" ? "timeout" : "network_error",
        reason: kind === "timeout"
          ? `Xbox did not answer the change request within ${CHANGE_TIMEOUT_MS / 1000} s. The account's gamertag is still "${record.assignedGamertag ?? "unknown"}" per Xbox — not confirmed.`
          : `Lost connection to Xbox during the change request. Not confirmed (account gamertag per Xbox: "${record.assignedGamertag ?? "unknown"}").`,
      });
    }
    record.latency.changeMs = ms(tChange);

    const cs = change.status;
    const cBody = change.text;
    const cDesc = xboxDescription(cBody);
    const cbase = { step: "change" as const, httpStatus: cs, xboxResponse: snippet(cBody) };

    if (cs === 200 || cs === 201 || cs === 202 || cs === 204) {
      let assigned: string | null = null;
      let suffix = "";
      try {
        const d = JSON.parse(cBody) as {
          classicGamertag?: string; gamertag?: string; Gamertag?: string;
          gamertagSuffix?: string; GamertagSuffix?: string;
        };
        assigned = d.classicGamertag ?? d.gamertag ?? d.Gamertag ?? null;
        suffix = (d.gamertagSuffix ?? d.GamertagSuffix ?? "").trim();
      } catch { /* no JSON body */ }

      if (assigned && sameTag(assigned, gamertag) && !suffix) {
        return finish("claimed", { ...cbase, assignedGamertag: assigned, confirmedBy: "change_response", errorCode: null, reason: null });
      }
      // Accepted, but the body doesn't prove the exact name: confirm independently.
      const confirmed = await confirmViaIdentity(record, gamertag, accountId);
      if (confirmed) {
        return finish("claimed", { ...cbase, step: "confirm", confirmedBy: "xsts_identity", errorCode: null, reason: null });
      }
      if (assigned && (!sameTag(assigned, gamertag) || suffix)) {
        return finish("unknown", {
          ...cbase, errorCode: "suffix_assigned", assignedGamertag: `${assigned}${suffix ? `#${suffix}` : ""}`,
          reason: `Xbox answered HTTP ${cs} with "${assigned}${suffix ? `#${suffix}` : ""}" instead of "${gamertag}". Check the account's gamertag.`,
        });
      }
      return finish("unknown", {
        ...cbase, errorCode: "unconfirmed",
        reason: `Xbox answered HTTP ${cs} but did not confirm the new gamertag, and the account still reports "${record.assignedGamertag ?? "unknown"}".`,
      });
    }
    if (cs === 429) {
      return finish("rate_limited", {
        ...cbase, errorCode: "rate_limited", retryAfterMs: retryAfterMs(change.headers, 30_000),
        reason: "Xbox rate-limited the change request (HTTP 429).",
      });
    }
    if (cs === 401) {
      return finish("auth_error", {
        ...cbase, errorCode: "auth_failed",
        reason: `Xbox refused this account's authorization for the change (HTTP 401)${cDesc ? `: ${cDesc}` : ""}. Reconnect Xbox.`,
      });
    }
    if (cs === 403) {
      const code = xboxErrorCode(cBody);
      const known = code !== null ? ACCOUNTS_ERROR[code] : undefined;
      return finish("claim_failed", {
        ...cbase,
        errorCode: "not_allowed",
        reason: known ?? `Xbox refused the gamertag change for this account (HTTP 403)${cDesc ? `: ${cDesc}` : ""}. The account may not have a free gamertag change, or is restricted.`,
      });
    }
    if (cs === 409) {
      return finish("claim_failed", {
        ...cbase, errorCode: "taken",
        reason: `Xbox reports "${gamertag}" was taken before the change completed (HTTP 409)${cDesc ? `: ${cDesc}` : ""}.`,
      });
    }
    if (cs === 400) {
      const code = xboxErrorCode(cBody);
      const known = code !== null ? ACCOUNTS_ERROR[code] : undefined;
      return finish("claim_failed", {
        ...cbase,
        errorCode: known ? "taken" : "rejected",
        reason: known ?? `Xbox rejected the change (HTTP 400)${cDesc ? `: ${cDesc}` : ""}.`,
      });
    }
    if (cs === 404) {
      return finish("claim_failed", {
        ...cbase, errorCode: "not_found",
        reason: `Xbox returned HTTP 404 for the change request${cDesc ? `: ${cDesc}` : ""}.`,
      });
    }
    if (cs === 405) {
      // The URL exists but this HTTP method is wrong. Xbox is required to name
      // the methods it does accept in the Allow header — surface it verbatim
      // so the next guess doesn't have to be blind.
      const allow = change.headers.get("allow");
      return finish("unknown", {
        ...cbase, errorCode: "xbox_error",
        reason: `Xbox rejected the HTTP method for the change request (405)${allow ? ` — it accepts: ${allow}` : " (no Allow header returned)"}. Not confirmed; nothing was changed.`,
      });
    }
    // 5xx or anything else: the change may have been applied. Ask Xbox.
    const confirmed = await confirmViaIdentity(record, gamertag, accountId);
    if (confirmed) return finish("claimed", { ...cbase, step: "confirm", confirmedBy: "xsts_identity", errorCode: null, reason: null });
    if (cs >= 500) {
      return finish("claim_failed", {
        ...cbase, errorCode: "xbox_error",
        reason: `Xbox server error on change (HTTP ${cs}); the account still reports "${record.assignedGamertag ?? "unknown"}".`,
      });
    }
    return finish("unknown", {
      ...cbase, errorCode: "xbox_error",
      reason: `Unexpected change response HTTP ${cs}; not confirmed.`,
    });
  } catch (err) {
    logger.warn({ gamertag, errName: err instanceof Error ? err.name : "unknown" }, "Claim failed unexpectedly");
    return finish("unknown", { errorCode: "xbox_error", reason: "Unexpected error during the claim; not confirmed." });
  } finally {
    busy.delete(accountId);
  }
}

/** Re-issues XSTS and checks whether Xbox now reports the requested gamertag. */
// Xbox's account/profile service (accounts.xboxlive.com) and its sign-in
// token service (xsts.auth.xboxlive.com, which is what tells us the
// account's gamertag) are separate systems. A change accepted by the former
// can take a few seconds to be visible to the latter. Live testing
// (2026-09-23) showed a real, Xbox-confirmed rename reported as
// "unconfirmed" because the identity check ran once, immediately, before
// that propagation finished. Retry with short pauses instead of giving up
// after one instant check.
const CONFIRM_RETRY_DELAYS_MS = [1_500, 2_000, 2_500];

async function confirmViaIdentity(record: ClaimRecord, gamertag: string, accountId: string): Promise<boolean> {
  const t = now();
  try {
    for (let attempt = 0; ; attempt++) {
      const id = await refreshActiveIdentity(accountId);
      record.assignedGamertag = id.gamertag;
      if (id.ok && sameTag(id.gamertag, gamertag)) return true;
      const delay = CONFIRM_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return false;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } catch {
    return false;
  } finally {
    record.latency.confirmMs = ms(t);
  }
}

/** Keeps the TLS connection to the claim host warm. */
export function warmClaimConnection(): Promise<number | null> {
  return warmConnection(`${GAMERTAG_HOST}/`);
}

// ─── Notifications ────────────────────────────────────────────────────────────

const STATE_LABEL: Record<ClaimState, string> = {
  claiming: "CLAIMING",
  claimed: "CLAIMED",
  claim_failed: "CLAIM FAILED",
  auth_error: "AUTH ERROR",
  rate_limited: "RATE LIMITED",
  network_error: "NETWORK ERROR",
  unknown: "UNKNOWN",
};
export const claimStateLabel = (s: ClaimState): string => STATE_LABEL[s];

/**
 * Discord notification for a FINISHED claim. The success embed is only ever
 * built for state === "claimed" (Xbox-confirmed); everything else is sent as a
 * failure with Xbox's actual reason.
 */
export async function notifyClaimWebhook(record: ClaimRecord, title: string): Promise<boolean> {
  if (record.state === "claiming") return false;
  const target = getWebhookTarget();
  if (!target) return false;
  const claimed = record.state === "claimed";
  const fields = [
    { name: "Gamertag", value: record.gamertag, inline: true },
    { name: "Status", value: STATE_LABEL[record.state], inline: true },
  ];
  if (claimed) {
    fields.push({ name: "Claim latency", value: `${record.latency.totalMs ?? "?"}ms`, inline: true });
    fields.push({ name: "Confirmed by", value: record.confirmedBy === "change_response" ? "Xbox change response" : "Xbox account identity (XSTS)", inline: true });
  } else {
    fields.push({ name: "Reason", value: (record.reason ?? "Unknown").slice(0, 1000), inline: false });
    if (record.httpStatus !== null) fields.push({ name: "Xbox HTTP", value: String(record.httpStatus), inline: true });
  }
  const ok = await sendWebhookPayload(target, {
    username: "Universal Checker",
    embeds: [{
      title,
      color: claimed ? 0xd4a72c : 0x8b2e2e,
      fields,
      footer: { text: "Universal Checker" },
      timestamp: new Date(record.finishedAt ?? Date.now()).toISOString(),
    }],
  });
  if (!ok) logger.warn({ gamertag: record.gamertag }, "Discord claim notification failed");
  return ok;
}

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

import { logger } from "./logger";
import { validateXboxGamertag } from "./xbox-validation";
import { getClaimContext, refreshActiveIdentity, getActiveAccountId, getAccountInfoList } from "./xbox-auth";
import { fastFetch, retryAfterMs, warmConnection } from "./xbox-http";
import { getWebhookTarget, sendWebhookPayload } from "./webhook-store";
import { recordClaim } from "./stats";
import { logAudit } from "./audit";

const GAMERTAG_HOST = "https://gamertag.xboxlive.com";
const RESERVE_URL   = `${GAMERTAG_HOST}/gamertags/reserve`;
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
// A non-destructive availability check: reserve the exact name (step 1 of
// the real claim flow), then ask the real change endpoint to preview the
// change (PreviewOnly: true) instead of applying it — never PreviewOnly:
// false, so nothing is ever actually renamed.
//
// History, so this isn't re-litigated blind a fourth time: this probe
// originally only did the reserve call and inspected ITS body for
// gamertagSuffix/classicGamertag fields, on the assumption that reserve
// carries suffix info. That assumption was never actually confirmed live —
// only the reserve→change STRUCTURE was confirmed, not what reserve's body
// says about suffixes — and real usage proved it wrong (hits kept coming
// back suffixed at close to 100%). The separate Double Check policy
// endpoint (user.mgt.xboxlive.com, in xbox-availability.ts) was ruled out
// earlier for the same reason: it answers content-policy acceptability, not
// suffix allocation.
//
// Every raw response body this probe sees is logged (truncated, no auth
// headers) at debug level under "xbox_probe" so that if this STILL doesn't
// catch a suffix case, the next report comes with real Xbox response data
// to fix from instead of another guess.

export type ReservationProbeStatus =
  | "available" | "taken" | "suffix_required" | "auth_required" | "rate_limited" | "error";

export interface ReservationProbeResult {
  status: ReservationProbeStatus;
  message?: string;
  httpStatus?: number;
}

/** True only when a response body affirmatively signals the exact classic name is free, with no suffix. */
function suffixFromBody(body: string, gamertag: string): { suffixed: boolean; reserved?: string; suffix?: string } {
  try {
    const r = JSON.parse(body) as Record<string, unknown>;
    const reserved = (r["classicGamertag"] ?? r["gamertag"] ?? r["Gamertag"] ?? r["modernGamertag"]) as string | undefined;
    const suffix = (r["gamertagSuffix"] ?? r["GamertagSuffix"] ?? r["suffix"]) as string | undefined;
    const hasFree = r["hasFree"];
    if (typeof suffix === "string" && suffix.trim()) return { suffixed: true, reserved, suffix };
    if (reserved && !sameTag(reserved, gamertag)) return { suffixed: true, reserved };
    if (hasFree === false) return { suffixed: true };
    return { suffixed: false, reserved };
  } catch {
    return { suffixed: false };
  }
}

export async function probeGamertagReservation(
  gamertag: string,
  accountId?: AccountSelection,
): Promise<ReservationProbeResult> {
  const selection = selectAccountForClaim(accountId);
  if (!selection.ok) {
    return { status: selection.kind === "busy" ? "error" : "auth_required", message: selection.reason };
  }
  const id = selection.accountId;
  // Never probe an account mid a real claim — a probe's own reserve call
  // could otherwise land in between that claim's reserve and change steps.
  if (claimInProgress(id)) {
    return { status: "error", message: "This account has a claim in progress; skipped the probe." };
  }

  const ctx = await getClaimContext(id);
  if (!ctx.ok) return { status: "auth_required", message: ctx.reason };

  try {
    const reserve = await send(RESERVE_URL, ctx.authHeader, {
      classicGamertag: gamertag,
      reservationId: ctx.xuid,
      targetGamertagFields: "classicGamertag",
    }, RESERVE_TIMEOUT_MS);
    logger.debug({ gamertag, endpoint: "reserve", status: reserve.status, body: snippet(reserve.text) }, "xbox_probe");

    const rs = reserve.status;
    if (rs === 429) {
      return { status: "rate_limited", httpStatus: rs, message: "Xbox rate-limited the reservation probe." };
    }
    if (rs === 401 || rs === 403) {
      return { status: "auth_required", httpStatus: rs, message: "Xbox rejected this account's authorization for the reservation probe." };
    }
    if (rs === 409) {
      return { status: "taken", httpStatus: rs, message: "Xbox reports this gamertag is taken or reserved by someone else." };
    }
    if (rs === 400) {
      return { status: "taken", httpStatus: rs, message: "Xbox rejected this gamertag." };
    }
    if (rs !== 200 && rs !== 201 && rs !== 204) {
      return { status: "error", httpStatus: rs, message: `Unexpected reservation probe response HTTP ${rs}.` };
    }

    const reserveCheck = suffixFromBody(reserve.text, gamertag);
    if (reserveCheck.suffixed) {
      return {
        status: "suffix_required",
        httpStatus: rs,
        message: `Xbox would only reserve "${reserveCheck.reserved ?? gamertag}${reserveCheck.suffix ? `#${reserveCheck.suffix}` : ""}", not the exact "${gamertag}".`,
      };
    }

    // Reserve alone didn't flag a suffix. Ask the real change endpoint to
    // PREVIEW the change (never applying it) — this is the step that
    // actually performs the rename in a real claim, so it's the more
    // credible source for whether the exact classic name would be granted.
    let preview;
    try {
      preview = await send(CHANGE_URL, ctx.authHeader, {
        Gamertag: gamertag,
        PreviewOnly: true,
        ReservationId: ctx.xuid,
      }, RESERVE_TIMEOUT_MS, { method: "POST", contractVersion: "3" });
    } catch (err) {
      // The preview call failing doesn't invalidate a clean reserve result;
      // fall back to it rather than blocking every hit on this second call.
      logger.debug({ gamertag, endpoint: "preview", err: err instanceof Error ? err.message : String(err) }, "xbox_probe");
      return { status: "available", httpStatus: rs };
    }
    logger.debug({ gamertag, endpoint: "preview", status: preview.status, body: snippet(preview.text) }, "xbox_probe");

    if (preview.status === 429) {
      return { status: "rate_limited", httpStatus: preview.status, message: "Xbox rate-limited the reservation probe." };
    }
    if (preview.status === 409 || preview.status === 400) {
      const desc = xboxDescription(preview.text);
      return {
        status: "suffix_required", httpStatus: preview.status,
        message: desc ? `Xbox would not grant the exact "${gamertag}": ${desc}` : `Xbox would not grant the exact "${gamertag}" with no suffix.`,
      };
    }
    if (preview.status === 200 || preview.status === 201 || preview.status === 204) {
      const previewCheck = suffixFromBody(preview.text, gamertag);
      if (previewCheck.suffixed) {
        return {
          status: "suffix_required",
          httpStatus: preview.status,
          message: `Xbox would only grant "${previewCheck.reserved ?? gamertag}${previewCheck.suffix ? `#${previewCheck.suffix}` : ""}", not the exact "${gamertag}".`,
        };
      }
    }
    return { status: "available", httpStatus: rs };
  } catch (err) {
    const kind = errorKind(err);
    return {
      status: "error",
      message: kind === "timeout" ? "The reservation probe timed out." : "Could not reach Xbox for the reservation probe.",
    };
  }
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
    try {
      const r = JSON.parse(rBody) as { classicGamertag?: string; gamertag?: string; gamertagSuffix?: string };
      const reserved = r.classicGamertag ?? r.gamertag;
      if ((r.gamertagSuffix && r.gamertagSuffix.trim()) || (reserved && !sameTag(reserved, gamertag))) {
        return finish("claim_failed", {
          ...base, errorCode: "suffix_required",
          reason: `Xbox would only reserve "${reserved ?? gamertag}${r.gamertagSuffix ? `#${r.gamertagSuffix}` : ""}", not the exact "${gamertag}". Claim aborted.`,
        });
      }
    } catch { /* empty/non-JSON body: the status code is the confirmation */ }

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

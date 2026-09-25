/**
 * Xbox availability checks shared by the Checker and the Sniper.
 *
 * Moved out of routes/gamertag.ts unchanged so both features classify a
 * gamertag the same way:
 *   Primary   — avatar-ssl.xboxlive.com CDN: 200 = taken, 401/404 = available.
 *   Double Check — user.mgt.xboxlive.com/gamertags/reserve (Ethan policy):
 *               200 = approved, 400 = banned, 409 = unavailable.
 * With Double Check on, only a primary "available" that the policy check
 * returns exactly `approved` for may be treated as available.
 */

import { logger } from "./logger";
import { isBlockedByContentFilter } from "./content-filter";
import { getAccountInfoList, getClaimContext } from "./xbox-auth";
import { fastFetch, retryAfterMs, xboxUrl } from "./xbox-http";

export type ResultStatus = "available" | "taken" | "inappropriate" | "seen" | "unknown" | "error";

export type PolicyStatus =
  | "approved"
  | "banned"
  | "unavailable"
  | "rate_limited"
  | "auth_required"
  | "not_configured"
  | "error";

export interface PolicyResult {
  status: PolicyStatus;
  message?: string;
  /** HTTP status Xbox returned, when a response was received. */
  httpStatus?: number;
  /** Server-requested backoff after a 429, in ms. */
  retryAfterMs?: number;
}

const ETHAN_POLICY_URL = "https://user.mgt.xboxlive.com/gamertags/reserve";

/**
 * Spacing between Double Check requests, tracked per Xbox account. This
 * endpoint is tied to one account's XSTS token, so — unlike the Discord
 * checker's proxy pool — the way to raise the ceiling is connecting more
 * Xbox accounts (Settings → Connect Xbox → "Add another") rather than
 * finding more IPs; requests then round-robin across every connected,
 * ready account instead of all queuing behind one account's budget.
 *
 * The 350ms floor is a starting guess per account, not a known-correct
 * number. Rather than stay pinned to it (which either wastes headroom Xbox
 * would actually allow, or keeps re-triggering a limit that's actually
 * tighter than 350ms), each account's spacing adapts independently: a 429's
 * own Retry-After raises that account's floor immediately so its *next*
 * request waits long enough the first time, and a run of clean responses on
 * that account relaxes it back down in steps — so one account tightening up
 * doesn't slow the others, and doesn't stay slow once Xbox calms down.
 */
const POLICY_SPACING_FLOOR_MS = 350;
const POLICY_SPACING_CAP_MS = 8_000;
const POLICY_RELAX_AFTER_OK = 5;

interface AccountPolicyState {
  spacingMs: number;
  consecutiveOk: number;
  lastRequestAt: number;
  queue: Promise<void>;
}
const policyStateByAccount = new Map<string, AccountPolicyState>();
let accountCursor = 0;

function policyStateFor(accountId: string): AccountPolicyState {
  let state = policyStateByAccount.get(accountId);
  if (!state) {
    state = { spacingMs: POLICY_SPACING_FLOOR_MS, consecutiveOk: 0, lastRequestAt: 0, queue: Promise.resolve() };
    policyStateByAccount.set(accountId, state);
  }
  return state;
}

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** A 429 raises this account's spacing floor to at least what Xbox itself asked for. */
function raisePolicySpacing(accountId: string, ms: number): void {
  const state = policyStateFor(accountId);
  state.spacingMs = Math.min(POLICY_SPACING_CAP_MS, Math.max(state.spacingMs, ms));
  state.consecutiveOk = 0;
}

/** A streak of decisive (non-429) responses on this account steps its spacing back toward the floor. */
function notePolicyOk(accountId: string): void {
  const state = policyStateFor(accountId);
  if (state.spacingMs <= POLICY_SPACING_FLOOR_MS) return;
  state.consecutiveOk++;
  if (state.consecutiveOk >= POLICY_RELAX_AFTER_OK) {
    state.spacingMs = Math.max(POLICY_SPACING_FLOOR_MS, Math.round(state.spacingMs * 0.7));
    state.consecutiveOk = 0;
  }
}

function waitForPolicyRequestSlot(accountId: string, signal: AbortSignal): Promise<void> {
  const state = policyStateFor(accountId);
  const acquire = state.queue.then(async () => {
    const delay = Math.max(0, state.spacingMs - (Date.now() - state.lastRequestAt));
    if (delay > 0) await wait(delay, signal);
    if (!signal.aborted) state.lastRequestAt = Date.now();
  });
  state.queue = acquire.catch(() => undefined);
  return acquire;
}

/**
 * Per-account cooldown after repeated auth failures, so one broken account
 * (revoked refresh token, etc.) doesn't eat an equal share of every
 * round-robin turn forever — mirrors the Discord checker's per-proxy
 * cooldown. Deliberately *not* a precondition on picking an account (no
 * "must already have a valid cached token" filter): a freshly connected
 * account has no cached XSTS token yet — that's exactly what
 * getClaimContext(accountId) mints on first use — so gating on it here
 * would mean a brand-new account could never be picked long enough to ever
 * become ready.
 */
interface AccountHealth { deadUntil: number; consecutiveAuthFail: number }
const accountHealth = new Map<string, AccountHealth>();
const ACCOUNT_AUTH_FAIL_STRIKES = 2;
const ACCOUNT_AUTH_FAIL_COOLDOWN_MS = 30_000;

function markAccountAuthFail(accountId: string): void {
  const health = accountHealth.get(accountId) ?? { deadUntil: 0, consecutiveAuthFail: 0 };
  health.consecutiveAuthFail++;
  if (health.consecutiveAuthFail >= ACCOUNT_AUTH_FAIL_STRIKES) {
    health.deadUntil = Date.now() + ACCOUNT_AUTH_FAIL_COOLDOWN_MS;
    health.consecutiveAuthFail = 0;
  }
  accountHealth.set(accountId, health);
}
function markAccountAuthOk(accountId: string): void {
  accountHealth.set(accountId, { deadUntil: 0, consecutiveAuthFail: 0 });
}

/**
 * Round-robins across every connected Xbox account, skipping ones currently
 * in an auth-failure cooldown. With one account connected (today's common
 * case) this always returns that same account — identical behaviour to
 * before accounts were poolable. With several, load spreads across them the
 * same way the Discord checker spreads across proxies.
 */
function pickPolicyAccount(): string | null {
  const all = getAccountInfoList();
  if (all.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < all.length; i++) {
    const idx = (accountCursor + i) % all.length;
    const candidate = all[idx]!;
    const health = accountHealth.get(candidate.id);
    if (!health || health.deadUntil <= now) {
      accountCursor = idx + 1;
      return candidate.id;
    }
  }
  // Every account is cooling down: use one anyway rather than stalling entirely.
  const candidate = all[accountCursor % all.length]!;
  accountCursor++;
  return candidate.id;
}

/**
 * Double Check. `opts.accountId` pins a specific account; omitted, one is
 * chosen by round-robin across every connected, ready account. `opts.retryOn429`
 * keeps the checker's original behaviour (one retry, waiting whatever Xbox's
 * own Retry-After says); the sniper passes false and applies its own backoff.
 * `opts.fast` routes the request through the keep-alive agent.
 */
export async function runEthanPolicyCheck(
  gamertag: string,
  signal: AbortSignal,
  opts: { retryOn429?: boolean; fast?: boolean; accountId?: string } = {},
): Promise<PolicyResult> {
  const retryOn429 = opts.retryOn429 ?? true;
  const accountId = opts.accountId ?? pickPolicyAccount();
  if (!accountId) return { status: "auth_required", message: "Sign in to Xbox to run the secondary policy check." };

  const ctx = await getClaimContext(accountId);
  if (!ctx.ok) {
    markAccountAuthFail(accountId);
    return { status: "auth_required", message: ctx.reason };
  }
  markAccountAuthOk(accountId);
  const authHeader = ctx.authHeader;
  // Xbox's reserve API accepts the account's XUID as the reservationId. The
  // explicit env value remains available for accounts or legacy flows that
  // provide a different reservation identifier.
  const reservationId = process.env.XBOX_RESERVATION_ID?.trim() || ctx.xuid;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await waitForPolicyRequestSlot(accountId, signal);
      const init = {
        method: "POST",
        signal,
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          "x-xbl-contract-version": "1",
        },
        body: JSON.stringify({ gamertag, reservationId }),
      };
      const response = opts.fast
        ? await fastFetch(ETHAN_POLICY_URL, init)
        : await fetch(xboxUrl(ETHAN_POLICY_URL), init);
      const httpStatus = response.status;
      // Drain the body on every non-200 path so the keep-alive socket can be
      // reused; the 200 path below reads the body itself instead.
      if (opts.fast && response.status !== 200) void response.text().catch(() => undefined);

      if (response.status === 200) {
        notePolicyOk(accountId);
        // A 200 here does not by itself guarantee the *exact* gamertag is
        // reservable — like the separate reserve call the claim flow makes,
        // Xbox can respond 200 while only offering the name with a suffix
        // (gamertagSuffix / a different classicGamertag) attached, meaning
        // the exact typed name is actually taken. Reported as "available"
        // without checking this, a hit could pass Double Check and still
        // turn out to need a suffix when actually claimed. If the body
        // doesn't parse or doesn't carry these fields, this is a no-op and
        // the check passes through as approved, same as before.
        let body = "";
        try { body = await response.text(); } catch { /* treat as approved below */ }
        try {
          const data = JSON.parse(body) as { classicGamertag?: string; gamertag?: string; gamertagSuffix?: string };
          const offered = data.classicGamertag ?? data.gamertag;
          const suffix = (data.gamertagSuffix ?? "").trim();
          const offeredDiffers = typeof offered === "string" && offered.trim().toUpperCase() !== gamertag.trim().toUpperCase();
          if (suffix || offeredDiffers) {
            return {
              status: "unavailable",
              message: `Xbox would only reserve "${offered ?? gamertag}${suffix ? `#${suffix}` : ""}", not the exact "${gamertag}".`,
              httpStatus,
            };
          }
        } catch { /* not JSON, or missing fields: treat as approved */ }
        return { status: "approved", httpStatus };
      }
      if (response.status === 400) { notePolicyOk(accountId); return { status: "banned", message: "Xbox marked this gamertag as unacceptable.", httpStatus }; }
      if (response.status === 409) { notePolicyOk(accountId); return { status: "unavailable", message: "Xbox reports this gamertag is no longer available.", httpStatus }; }
      if (response.status === 401 || response.status === 403) {
        return { status: "auth_required", message: "The Xbox authorization token was rejected.", httpStatus };
      }
      if (response.status === 429) {
        const backoffMs = retryAfterMs(response.headers as Headers, attempt === 0 ? 2_000 : 5_000);
        raisePolicySpacing(accountId, backoffMs);
        if (attempt === 0 && retryOn429) {
          logger.warn({ gamertag, accountId, backoffMs }, "Ethan policy check rate-limited; retrying");
          await wait(backoffMs, signal);
          continue;
        }
        return {
          status: "rate_limited",
          message: "Xbox rate-limited the secondary policy check.",
          httpStatus,
          retryAfterMs: backoffMs,
        };
      }

      logger.warn({ gamertag, accountId, status: response.status }, "Unexpected Ethan policy check response");
      return { status: "error", message: `Xbox returned HTTP ${response.status}.`, httpStatus };
    } catch (err) {
      if (signal.aborted) return { status: "error", message: "Secondary policy check cancelled." };
      logger.warn({ gamertag, accountId, errName: err instanceof Error ? err.name : "unknown" }, "Ethan policy check request failed");
      return { status: "error", message: "Secondary policy check failed." };
    }
  }
  return { status: "rate_limited", message: "Xbox rate-limited the secondary policy check." };
}

// ─── Availability check ───────────────────────────────────────────────────────
//
// Endpoint cascade (in priority order):
//   1. gamertag.xboxlive.com/gamertags/{gt}/availability  — authenticated; most accurate
//   2. avatar-ssl.xboxlive.com CDN                        — unauthenticated fallback
//
// NOTE: profile.xboxlive.com is intentionally NOT used — it is rate-limited
// (Retry-After: 299) from Replit server IPs even with valid XSTS auth.

/**
 * Primary check — gamertag.xboxlive.com availability endpoint.
 * Requires a valid XSTS auth header. Returns null if the endpoint is
 * unavailable/rate-limited so the caller can fall through to the CDN.
 */
export async function checkViaAvailabilityEndpoint(
  gt: string,
  authHeader: string,
  signal: AbortSignal,
): Promise<Exclude<ResultStatus, "error"> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        xboxUrl(`https://gamertag.xboxlive.com/gamertags/${encodeURIComponent(gt)}/availability`),
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

/** Full detail of one CDN lookup, for callers (the sniper) that report why a check was inconclusive. */
export interface CdnDetail {
  status: "available" | "taken" | null;
  httpStatus: number | null;
  /** Set when no HTTP response was received. */
  networkError?: "timeout" | "network";
  retryAfterMs?: number;
}

export async function checkViaCDNDetailed(
  gt: string,
  signal: AbortSignal,
  fast = false,
): Promise<CdnDetail> {
  const url = `https://avatar-ssl.xboxlive.com/avatar/${encodeURIComponent(gt)}/avatar-body.png`;
  try {
    const res = fast
      ? await fastFetch(url, { signal, headers: { Accept: "image/png" } })
      : await fetch(xboxUrl(url), { signal, headers: { Accept: "image/png" } });
    // Drain so a keep-alive socket can be reused.
    if (fast) void res.text().catch(() => undefined);

    if (res.status === 200) return { status: "taken", httpStatus: 200 };                          // in CDN = profile exists
    if (res.status === 401 || res.status === 404) return { status: "available", httpStatus: res.status }; // not in CDN = likely free
    if (res.status === 429) {
      return { status: null, httpStatus: 429, retryAfterMs: retryAfterMs(res.headers as Headers, 5_000) };
    }
    return { status: null, httpStatus: res.status };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { status: null, httpStatus: null, networkError: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
}

/**
 * CDN fallback — avatar-ssl.xboxlive.com.
 * Works without auth. Checks if the gamertag has a classic Xbox 360 CDN entry.
 *   • HTTP 200 → avatar image served → gamertag is TAKEN
 *   • HTTP 401 → not in CDN → likely AVAILABLE (medium confidence for 3–4 char tags)
 */
export async function checkViaCDN(
  gt: string,
  signal: AbortSignal,
): Promise<Exclude<ResultStatus, "error"> | null> {
  const d = await checkViaCDNDetailed(gt, signal);
  return d.status;
}

// ─── Primary check ────────────────────────────────────────────────────────────
//
// Bulk search uses CDN-only (fastest, no rate-limit issues).
// The authenticated availability endpoint always 404s with the current XSTS
// relying party ("http://xboxlive.com") — so we skip it in bulk mode to
// avoid the extra round-trip and double the effective CPS.
// Single-tag /verify still tries the availability endpoint first.

export async function checkGamertag(gt: string, signal: AbortSignal): Promise<ResultStatus> {
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

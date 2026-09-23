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
import { getAuthHeader, getXuid } from "./xbox-auth";
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
const POLICY_REQUEST_SPACING_MS = 350;
let lastPolicyRequestAt = 0;
let policyRequestQueue = Promise.resolve();

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
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

/**
 * Double Check. `opts.retryOn429` keeps the checker's original behaviour (one
 * 5-second retry); the sniper passes false and applies its own backoff.
 * `opts.fast` routes the request through the keep-alive agent.
 */
export async function runEthanPolicyCheck(
  gamertag: string,
  signal: AbortSignal,
  opts: { retryOn429?: boolean; fast?: boolean } = {},
): Promise<PolicyResult> {
  const retryOn429 = opts.retryOn429 ?? true;
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
      // Drain the body so the keep-alive socket can be reused.
      if (opts.fast) void response.text().catch(() => undefined);
      const httpStatus = response.status;

      if (response.status === 200) return { status: "approved", httpStatus };
      if (response.status === 400) return { status: "banned", message: "Xbox marked this gamertag as unacceptable.", httpStatus };
      if (response.status === 409) return { status: "unavailable", message: "Xbox reports this gamertag is no longer available.", httpStatus };
      if (response.status === 401 || response.status === 403) {
        return { status: "auth_required", message: "The Xbox authorization token was rejected.", httpStatus };
      }
      if (response.status === 429) {
        if (attempt === 0 && retryOn429) {
          logger.warn({ gamertag }, "Ethan policy check rate-limited; retrying in 5 seconds");
          await wait(5_000, signal);
          continue;
        }
        return {
          status: "rate_limited",
          message: "Xbox rate-limited the secondary policy check.",
          httpStatus,
          retryAfterMs: retryAfterMs(response.headers as Headers, 5_000),
        };
      }

      logger.warn({ gamertag, status: response.status }, "Unexpected Ethan policy check response");
      return { status: "error", message: `Xbox returned HTTP ${response.status}.`, httpStatus };
    } catch (err) {
      if (signal.aborted) return { status: "error", message: "Secondary policy check cancelled." };
      logger.warn({ gamertag, errName: err instanceof Error ? err.name : "unknown" }, "Ethan policy check request failed");
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

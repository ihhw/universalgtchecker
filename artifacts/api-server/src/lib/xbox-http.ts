/**
 * Shared HTTP transport for Microsoft / Xbox Live calls.
 *
 * - `xboxUrl()` rewrites a real Microsoft/Xbox URL to a local mock server when
 *   XBOX_MOCK_BASE is set. This exists ONLY so the full auth → check → claim
 *   chain can be exercised in tests without a real account; it is never set in
 *   production and the server logs a loud warning when it is.
 * - `fastFetch()` is used on the latency-critical sniper/claim path. It goes
 *   through a dedicated keep-alive agent so the TLS connection to each Xbox
 *   host is reused between requests instead of re-handshaking every time.
 */

import { Agent, fetch as undiciFetch } from "undici";
import { logger } from "./logger";

const MOCK_BASE = process.env["XBOX_MOCK_BASE"]?.trim().replace(/\/$/, "") || null;

if (MOCK_BASE) {
  logger.warn(
    { mockBase: MOCK_BASE },
    "XBOX_MOCK_BASE is set: ALL Microsoft/Xbox requests go to a local mock server. Never use this in production.",
  );
}

export function isMockTransport(): boolean {
  return MOCK_BASE !== null;
}

/** `https://host/path` → `${XBOX_MOCK_BASE}/host/path` in mock mode; unchanged otherwise. */
export function xboxUrl(url: string): string {
  if (!MOCK_BASE) return url;
  const u = new URL(url);
  return `${MOCK_BASE}/${u.host}${u.pathname}${u.search}`;
}

// Keep idle sockets open long enough to survive between sniper checks and to
// be warm when a claim fires. No per-origin connection cap is set, so bursts
// are never queued behind each other.
const keepAliveAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
  connect: { timeout: 10_000 },
});

export interface FastResponse {
  status: number;
  headers: Headers;
  text: () => Promise<string>;
}

export async function fastFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<FastResponse> {
  const res = await undiciFetch(xboxUrl(url), { ...init, dispatcher: keepAliveAgent });
  return {
    status: res.status,
    headers: res.headers as unknown as Headers,
    text: () => res.text(),
  };
}

/**
 * Opens (or keeps open) a TLS connection to `origin` so the next real request
 * skips the handshake. Unauthenticated HEAD; the status is irrelevant.
 */
export async function warmConnection(origin: string): Promise<number | null> {
  const started = performance.now();
  try {
    const res = await undiciFetch(xboxUrl(origin), {
      method: "HEAD",
      dispatcher: keepAliveAgent,
      signal: AbortSignal.timeout(5_000),
    });
    await res.arrayBuffer().catch(() => undefined);
    return Math.round(performance.now() - started);
  } catch {
    return null;
  }
}

/** Parse Retry-After (seconds or HTTP date) into ms, clamped. */
export function retryAfterMs(headers: Headers, fallbackMs: number, maxMs = 120_000): number {
  const raw = headers.get("retry-after");
  if (!raw) return fallbackMs;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs * 1_000), maxMs);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), maxMs);
  return fallbackMs;
}

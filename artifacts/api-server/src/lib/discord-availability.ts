/**
 * Discord username availability checks.
 *
 * Uses Discord's public, unauthenticated "unique username" attempt endpoint —
 * the same one the Discord client itself calls while you're typing a new
 * username during onboarding. No account or token is required to check.
 *
 * There is no official endpoint to CLAIM a username without an authenticated
 * user session, and driving one programmatically with a real user's token
 * would be self-bot automation, which Discord's Terms of Service prohibit.
 * This checker therefore only checks and alerts — it never attempts to claim.
 */

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { logger } from "./logger";
import { getProxies } from "./discord-proxy-store";

export type ResultStatus = "available" | "taken" | "unknown" | "error";

/** Rate ceiling shown to and enforced for the client — higher once proxies spread the load. */
export const MAX_RATE_NO_PROXY = 50;
export const MAX_RATE_WITH_PROXY = 500;

export function currentMaxRate(): number {
  return getProxies().length > 0 ? MAX_RATE_WITH_PROXY : MAX_RATE_NO_PROXY;
}

/** Worker concurrency scales with the proxy pool; one IP alone can't sustain much in flight. */
export function currentMaxConcurrency(): number {
  const n = getProxies().length;
  return n > 0 ? Math.min(200, Math.max(20, n * 4)) : 20;
}

const HOSTS = ["https://discord.com", "https://canary.discord.com", "https://ptb.discord.com"];
const PATH = "/api/v9/unique-username/username-attempt-unauthed";

const CF_MARKERS = ["cf-chl", "cf_chl", "challenge-platform", "cf-please-wait", "<!doctype html", "<html", "just a moment"];

function looksLikeChallenge(body: string): boolean {
  if (!body) return false;
  const low = body.slice(0, 500).toLowerCase();
  return CF_MARKERS.some((m) => low.includes(m));
}

function randomBuildNumber(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function channelFor(host: string): string {
  if (host.includes("canary")) return "canary";
  if (host.includes("ptb")) return "ptb";
  return "stable";
}

/**
 * A stable, per-identity set of headers. A real Discord install keeps the
 * same client/installation fingerprint for as long as it's running —
 * regenerating it on every request (the previous behaviour here) is a
 * *stronger* automation signal than keeping it fixed, since no real client
 * churns its own identity between consecutive calls. One of these is built
 * once per proxy (see identityFor) and reused for every check routed
 * through it, the same way one real, persistent installation would.
 */
interface Identity {
  superPropertiesByHost: Map<string, string>;
  fingerprint: string;
  userAgent: string;
}

const CHROME_VERSIONS = ["120.0.0.0", "121.0.0.0", "122.0.0.0", "123.0.0.0"];

function buildIdentity(): Identity {
  const clientBuild = randomBuildNumber(270_000, 275_000);
  const nativeBuild = randomBuildNumber(43_000, 45_000);
  const chrome = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)]!;

  const superPropertiesByHost = new Map<string, string>();
  for (const host of HOSTS) {
    const props = {
      os: "Windows",
      browser: "Discord Client",
      release_channel: channelFor(host),
      client_version: "1.0.9166",
      os_version: "10.0.22631",
      os_arch: "x64",
      system_locale: "en-US",
      client_build_number: clientBuild,
      native_build_number: nativeBuild,
      client_event_source: null,
    };
    superPropertiesByHost.set(host, Buffer.from(JSON.stringify(props)).toString("base64"));
  }

  const fp = {
    os: "Windows",
    browser: "Discord Client",
    release_channel: "stable",
    client_version: "1.0.9166",
    os_version: "10.0.22631",
    os_arch: "x64",
    system_locale: "en-US",
    client_build_number: clientBuild,
    native_build_number: nativeBuild,
  };

  return {
    superPropertiesByHost,
    fingerprint: Buffer.from(JSON.stringify(fp)).toString("base64"),
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`,
  };
}

/** One identity per proxy (persistent), plus one for the no-proxy path. */
const identities = new Map<string, Identity>();
const NO_PROXY_KEY = "__direct__";

function identityFor(key: string): Identity {
  let identity = identities.get(key);
  if (!identity) {
    identity = buildIdentity();
    identities.set(key, identity);
  }
  return identity;
}

function headersFor(host: string, identity: Identity): Record<string, string> {
  return {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    origin: "https://discord.com",
    referer: "https://discord.com/channels/@me",
    "user-agent": identity.userAgent,
    "x-discord-locale": "en-US",
    "x-discord-timezone": "America/New_York",
    "x-super-properties": identity.superPropertiesByHost.get(host)!,
    "x-fingerprint": identity.fingerprint,
  };
}

/** Parses Retry-After (seconds or an HTTP date) into ms, clamped to a sane range. */
export function retryAfterMs(headers: Headers, fallbackMs: number): number {
  const raw = headers.get("retry-after");
  if (!raw) return fallbackMs;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(Math.max(250, secs * 1_000), 60_000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(Math.max(250, at - Date.now()), 60_000);
  return fallbackMs;
}

/**
 * Proactive bucket awareness, mirrored per proxy (or globally for the
 * no-proxy path): when a response says only a couple of requests are left
 * before the bucket resets, the next check on that route waits for the
 * reset instead of firing straight into a 429 — Discord's own signal is
 * more precise than reacting after the fact.
 */
interface BucketState {
  remaining: number;
  resetAt: number;
}
const buckets = new Map<string, BucketState>();

function noteBucketHeaders(key: string, headers: Headers): void {
  const remaining = headers.get("x-ratelimit-remaining");
  const resetAfter = headers.get("x-ratelimit-reset-after");
  if (remaining === null || resetAfter === null) return;
  const remainingNum = Number(remaining);
  const resetAfterNum = Number(resetAfter);
  if (!Number.isFinite(remainingNum) || !Number.isFinite(resetAfterNum)) return;
  buckets.set(key, { remaining: remainingNum, resetAt: Date.now() + resetAfterNum * 1_000 });
}

function bucketWaitMs(key: string): number {
  const b = buckets.get(key);
  if (!b) return 0;
  if (b.resetAt <= Date.now()) return 0;
  return b.remaining <= 1 ? b.resetAt - Date.now() : 0;
}

/**
 * Process-wide circuit breaker used only when there are no proxies (one
 * shared IP): back off together after repeated 429s.
 */
let cooldownUntil = 0;
let consecutive429 = 0;
const CIRCUIT_THRESHOLD = 4;
const CIRCUIT_BREAK_MS = 8_000;

function noteRateLimited(extraMs = 0): void {
  consecutive429++;
  if (extraMs > 0) cooldownUntil = Math.max(cooldownUntil, Date.now() + extraMs);
  if (consecutive429 >= CIRCUIT_THRESHOLD) {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + CIRCUIT_BREAK_MS);
    consecutive429 = 0;
  }
}
function noteOk(): void {
  consecutive429 = 0;
}

export function msUntilReady(): number {
  return Math.max(0, cooldownUntil - Date.now(), bucketWaitMs(NO_PROXY_KEY));
}

/**
 * Per-proxy round-robin with a cooldown for proxies that keep failing, so a
 * few bad ones in a large list don't drag down the whole pool.
 */
interface ProxyState {
  deadUntil: number;
  consecutiveFail: number;
}
const proxyStates = new Map<string, ProxyState>();
const proxyAgents = new Map<string, ProxyAgent>();
let proxyCursor = 0;

function agentFor(proxy: string): ProxyAgent {
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent(proxy);
    proxyAgents.set(proxy, agent);
  }
  return agent;
}

function pickProxy(proxies: string[]): string | null {
  if (proxies.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < proxies.length; i++) {
    const idx = (proxyCursor + i) % proxies.length;
    const candidate = proxies[idx]!;
    const state = proxyStates.get(candidate);
    const bucketWait = bucketWaitMs(candidate);
    if ((!state || state.deadUntil <= now) && bucketWait <= 0) {
      proxyCursor = idx + 1;
      return candidate;
    }
  }
  // Every proxy is cooling down: use the one that frees up soonest rather
  // than stalling entirely.
  let best = proxies[proxyCursor % proxies.length]!;
  let bestReady = Infinity;
  for (const p of proxies) {
    const state = proxyStates.get(p);
    const ready = Math.max(state?.deadUntil ?? 0, Date.now() + bucketWaitMs(p));
    if (ready < bestReady) { bestReady = ready; best = p; }
  }
  proxyCursor++;
  return best;
}

const PROXY_DEAD_STRIKES = 3;
const PROXY_DEAD_COOLDOWN_MS = 30_000;
/** 401/403 usually means the proxy itself is bad (dead, blocked, needs auth we don't have), not a temporary limit. */
const PROXY_AUTH_FAIL_COOLDOWN_MS = 60_000;

function markProxyFail(proxy: string, cooldownMs = 0): void {
  const state = proxyStates.get(proxy) ?? { deadUntil: 0, consecutiveFail: 0 };
  state.consecutiveFail++;
  const strikeCooldown = state.consecutiveFail >= PROXY_DEAD_STRIKES ? PROXY_DEAD_COOLDOWN_MS : 0;
  const effective = Math.max(cooldownMs, strikeCooldown);
  if (effective > 0) {
    state.deadUntil = Math.max(state.deadUntil, Date.now() + effective);
    if (strikeCooldown > 0) state.consecutiveFail = 0;
  }
  proxyStates.set(proxy, state);
}
function markProxyOk(proxy: string): void {
  proxyStates.set(proxy, { deadUntil: 0, consecutiveFail: 0 });
}

export async function checkDiscordUsername(username: string, signal: AbortSignal): Promise<ResultStatus> {
  const proxies = getProxies();
  const proxy = pickProxy(proxies);
  const routeKey = proxy ?? NO_PROXY_KEY;

  // Wait out a known bucket exhaustion or (no-proxy only) the shared circuit
  // breaker before spending a request that would just come back 429.
  const wait = proxy ? bucketWaitMs(proxy) : msUntilReady();
  if (wait > 0) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.min(wait, 3_000));
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  const host = HOSTS[Math.floor(Math.random() * HOSTS.length)]!;
  const identity = identityFor(routeKey);
  let dispatcher: Dispatcher | undefined;
  try {
    if (proxy) dispatcher = agentFor(proxy);
  } catch (err) {
    logger.warn({ proxy, err }, "Could not build proxy agent; falling back to a direct request");
    dispatcher = undefined;
  }

  try {
    const res = await undiciFetch(host + PATH, {
      method: "POST",
      signal,
      headers: headersFor(host, identity),
      body: JSON.stringify({ username }),
      dispatcher,
    });

    noteBucketHeaders(routeKey, res.headers as unknown as Headers);

    let body = "";
    try { body = await res.text(); } catch { /* ignore */ }

    if (looksLikeChallenge(body)) {
      if (proxy) markProxyFail(proxy); else noteRateLimited();
      return "unknown";
    }
    if (res.status === 429) {
      const retryMs = retryAfterMs(res.headers as unknown as Headers, proxy ? PROXY_DEAD_COOLDOWN_MS : CIRCUIT_BREAK_MS);
      if (proxy) markProxyFail(proxy, retryMs); else noteRateLimited(retryMs);
      return "unknown";
    }
    if (res.status === 401 || res.status === 403) {
      if (proxy) markProxyFail(proxy, PROXY_AUTH_FAIL_COOLDOWN_MS); else noteRateLimited();
      return "unknown";
    }
    if (!res.ok) {
      logger.warn({ username, status: res.status, proxied: proxy !== null }, "Discord availability check unexpected status");
      if (proxy) markProxyFail(proxy);
      return "error";
    }

    if (proxy) markProxyOk(proxy); else noteOk();
    let data: unknown;
    try { data = JSON.parse(body); } catch { return "error"; }
    const taken = (data as { taken?: unknown } | null)?.taken;
    if (typeof taken === "boolean") return taken ? "taken" : "available";
    if ((data as { rate_limited?: unknown } | null)?.rate_limited) {
      if (proxy) markProxyFail(proxy); else noteRateLimited();
      return "unknown";
    }
    return "unknown";
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw err;
    }
    if (proxy) markProxyFail(proxy);
    return "error";
  }
}

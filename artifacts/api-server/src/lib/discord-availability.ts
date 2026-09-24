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

function superProperties(host: string): string {
  const props = {
    os: "Windows",
    browser: "Discord Client",
    release_channel: channelFor(host),
    client_version: "1.0.9166",
    os_version: "10.0.22631",
    os_arch: "x64",
    system_locale: "en-US",
    client_build_number: randomBuildNumber(270_000, 275_000),
    native_build_number: randomBuildNumber(43_000, 45_000),
    client_event_source: null,
  };
  return Buffer.from(JSON.stringify(props)).toString("base64");
}

function fingerprint(): string {
  const fp = {
    os: "Windows",
    browser: "Discord Client",
    release_channel: "stable",
    client_version: "1.0.9166",
    os_version: "10.0.22631",
    os_arch: "x64",
    system_locale: "en-US",
    client_build_number: randomBuildNumber(270_000, 275_000),
    native_build_number: randomBuildNumber(43_000, 45_000),
  };
  return Buffer.from(JSON.stringify(fp)).toString("base64");
}

function headersFor(host: string): Record<string, string> {
  return {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    origin: "https://discord.com",
    referer: "https://discord.com/channels/@me",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "x-discord-locale": "en-US",
    "x-discord-timezone": "America/New_York",
    "x-super-properties": superProperties(host),
    "x-fingerprint": fingerprint(),
  };
}

/**
 * Process-wide circuit breaker used only when there are no proxies (one
 * shared IP): back off together after repeated 429s.
 */
let cooldownUntil = 0;
let consecutive429 = 0;
const CIRCUIT_THRESHOLD = 4;
const CIRCUIT_BREAK_MS = 8_000;

function noteRateLimited(): void {
  consecutive429++;
  if (consecutive429 >= CIRCUIT_THRESHOLD) {
    cooldownUntil = Date.now() + CIRCUIT_BREAK_MS;
    consecutive429 = 0;
  }
}
function noteOk(): void {
  consecutive429 = 0;
}

export function msUntilReady(): number {
  return Math.max(0, cooldownUntil - Date.now());
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
    if (!state || state.deadUntil <= now) {
      proxyCursor = idx + 1;
      return candidate;
    }
  }
  // Every proxy is cooling down: use one anyway rather than stalling entirely.
  const candidate = proxies[proxyCursor % proxies.length]!;
  proxyCursor++;
  return candidate;
}

const PROXY_DEAD_STRIKES = 3;
const PROXY_DEAD_COOLDOWN_MS = 30_000;

function markProxyFail(proxy: string): void {
  const state = proxyStates.get(proxy) ?? { deadUntil: 0, consecutiveFail: 0 };
  state.consecutiveFail++;
  if (state.consecutiveFail >= PROXY_DEAD_STRIKES) {
    state.deadUntil = Date.now() + PROXY_DEAD_COOLDOWN_MS;
    state.consecutiveFail = 0;
  }
  proxyStates.set(proxy, state);
}
function markProxyOk(proxy: string): void {
  proxyStates.set(proxy, { deadUntil: 0, consecutiveFail: 0 });
}

export async function checkDiscordUsername(username: string, signal: AbortSignal): Promise<ResultStatus> {
  const proxies = getProxies();
  const proxy = pickProxy(proxies);

  // The shared, no-proxy circuit breaker only applies when every check comes
  // from this server's one IP; with a pool, a single bad proxy shouldn't
  // pause every other in-flight check.
  if (!proxy) {
    const wait = msUntilReady();
    if (wait > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(wait, 3_000));
        signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
  }

  const host = HOSTS[Math.floor(Math.random() * HOSTS.length)]!;
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
      headers: headersFor(host),
      body: JSON.stringify({ username }),
      dispatcher,
    });

    let body = "";
    try { body = await res.text(); } catch { /* ignore */ }

    if (looksLikeChallenge(body)) {
      if (proxy) markProxyFail(proxy); else noteRateLimited();
      return "unknown";
    }
    if (res.status === 429 || res.status === 401 || res.status === 403) {
      if (proxy) markProxyFail(proxy); else noteRateLimited();
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

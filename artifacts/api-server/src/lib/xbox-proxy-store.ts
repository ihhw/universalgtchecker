/**
 * Server-side proxy pool for the Xbox checker's primary CDN check.
 *
 * avatar-ssl.xboxlive.com has no auth, but it rate-limits a single IP hard
 * at any real volume — confirmed live: a 1000/s run from one home
 * connection collapsed to ~114/s actual throughput with 97% of checks
 * coming back "unknown" (the CDN check gives up on a 429/network failure
 * after one retry — see checkGamertag in xbox-availability.ts). Proxies are
 * optional: without any, checks go out directly from this server's own IP
 * and the rate is kept low (see MAX_RATE_NO_PROXY in xbox-availability.ts).
 * With proxies, load spreads across them and a much higher rate becomes
 * usable without every check past the first few hundred silently failing.
 *
 * Proxy URLs can carry credentials, so — like the Discord proxy pool and
 * the webhook URL — they are stored only on the server and never returned
 * to the browser; the API exposes just a count and a masked preview.
 *
 * The normalize/store logic here is a straight copy of
 * discord-proxy-store.ts (same accepted formats, same limits) rather than
 * a shared abstraction, to avoid risking the already-working Discord path
 * while adding this.
 */

import fs from "fs";
import path from "path";
import { logger } from "./logger";

const FILE = path.join(process.cwd(), "xbox-proxies.json");

interface Stored {
  proxies: string[];
}

let cache: Stored | null = null;

function load(): Stored {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<Stored>;
    cache = { proxies: Array.isArray(parsed.proxies) ? parsed.proxies.filter((p) => typeof p === "string") : [] };
  } catch {
    cache = { proxies: [] };
  }
  return cache;
}

function persist(next: Stored): void {
  cache = next;
  try {
    fs.writeFileSync(FILE, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    logger.warn({ err }, "Could not persist Xbox proxy settings");
  }
}

/**
 * Normalizes one proxy entry to `http://[user:pass@]host:port`. Accepts:
 *   - `http://…` / `https://…` (used as-is)
 *   - `host:port`
 *   - `host:port:user:pass`
 *   - `user:pass@host:port`
 * SOCKS proxies aren't supported (the HTTP CONNECT tunnel this checker uses
 * doesn't speak SOCKS) and are rejected with a clear reason.
 */
export function normalizeProxy(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const line = raw.trim();
  if (line === "" || line.startsWith("#")) return { ok: false, error: "" }; // blank/comment: silently skipped by the caller

  if (/^socks5h?:\/\//i.test(line)) {
    return { ok: false, error: `"${line}": SOCKS proxies aren't supported, only HTTP/HTTPS.` };
  }
  if (/^https?:\/\//i.test(line)) {
    try {
      const u = new URL(line);
      return { ok: true, url: `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`.replace(/\/$/, "") || `${u.protocol}//${u.host}` };
    } catch {
      return { ok: false, error: `"${line}" isn't a valid proxy URL.` };
    }
  }

  if (line.includes("@")) {
    const at = line.lastIndexOf("@");
    const auth = line.slice(0, at);
    const address = line.slice(at + 1);
    const colon = auth.indexOf(":");
    if (colon > 0 && address.includes(":")) {
      const user = auth.slice(0, colon);
      const password = auth.slice(colon + 1);
      const [host, port] = address.split(":");
      if (host && port && /^\d+$/.test(port)) {
        return { ok: true, url: `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}` };
      }
    }
    return { ok: false, error: `"${line}" isn't a recognized proxy format.` };
  }

  const parts = line.split(":");
  if (parts.length === 2) {
    const [host, port] = parts;
    if (host && port && /^\d+$/.test(port)) return { ok: true, url: `http://${host}:${port}` };
  }
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts;
    const password = rest.join(":");
    if (host && port && /^\d+$/.test(port) && user) {
      return { ok: true, url: `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}` };
    }
  }
  return { ok: false, error: `"${line}" isn't a recognized proxy format.` };
}

const MAX_PROXIES = 2_000;

export function setProxies(raw: string): { ok: true; count: number; skipped: number } | { ok: false; error: string } {
  const lines = raw.split(/\r?\n/);
  if (lines.length > MAX_PROXIES) {
    return { ok: false, error: `Too many lines (maximum ${MAX_PROXIES}).` };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const r = normalizeProxy(line);
    if (!r.ok) {
      if (r.error) errors.push(r.error);
      skipped++;
      continue;
    }
    if (!seen.has(r.url)) {
      seen.add(r.url);
      out.push(r.url);
    }
  }
  if (errors.length > 0 && out.length === 0) {
    return { ok: false, error: errors[0]! };
  }
  persist({ proxies: out });
  return { ok: true, count: out.length, skipped };
}

export function clearProxies(): void {
  persist({ proxies: [] });
}

export function getProxies(): string[] {
  return load().proxies;
}

export interface PublicProxyState {
  count: number;
  /** A few masked host:port pairs, credentials stripped, for a sanity-check preview. */
  preview: string[];
}

export function getPublicProxyState(): PublicProxyState {
  const proxies = load().proxies;
  const preview = proxies.slice(0, 5).map((p) => {
    try {
      const u = new URL(p);
      return u.host;
    } catch {
      return "…";
    }
  });
  return { count: proxies.length, preview };
}

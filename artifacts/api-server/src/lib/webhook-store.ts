import fs from "fs";
import path from "path";
import { logger } from "./logger";

/**
 * Server-side Discord webhook configuration.
 *
 * The webhook URL is a secret (anyone holding it can post to the channel), so
 * it is stored only on the server and never returned to the browser. The API
 * exposes a masked view instead.
 */

const FILE = path.join(process.cwd(), "webhook.json");
const ALLOWED_HOSTS = new Set([
  "discord.com",
  "ptb.discord.com",
  "canary.discord.com",
  "discordapp.com",
]);
const PATH_RE = /^\/api(?:\/v\d+)?\/webhooks\/(\d{5,25})\/([A-Za-z0-9_-]{20,200})\/?$/;

interface Stored {
  url: string | null;
  enabled: boolean;
}

let cache: Stored | null = null;

function load(): Stored {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<Stored>;
    cache = {
      url: typeof parsed.url === "string" && validateWebhookUrl(parsed.url).ok ? parsed.url : null,
      enabled: parsed.enabled === true,
    };
  } catch {
    cache = { url: null, enabled: false };
  }
  return cache;
}

function persist(next: Stored): void {
  cache = next;
  try {
    fs.writeFileSync(FILE, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    logger.warn({ err }, "Could not persist webhook settings");
  }
}

export function validateWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (u.protocol !== "https:") return { ok: false, error: "Webhook must use https." };
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    return { ok: false, error: "Webhook must be a discord.com webhook URL." };
  }
  if (u.port || u.username || u.password || u.search || u.hash) {
    return { ok: false, error: "Webhook URL must not include extra components." };
  }
  if (!PATH_RE.test(u.pathname)) {
    return { ok: false, error: "Expected https://discord.com/api/webhooks/{id}/{token}." };
  }
  return { ok: true, url: `https://${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, "")}` };
}

function envUrl(): string | null {
  const v = process.env.DISCORD_WEBHOOK_URL?.trim();
  return v && validateWebhookUrl(v).ok ? v : null;
}

/** URL to deliver alerts to, or null when alerts are off / unconfigured. */
export function getWebhookTarget(): string | null {
  const stored = load();
  if (stored.url) return stored.enabled ? stored.url : null;
  return envUrl();
}

export interface PublicWebhookState {
  configured: boolean;
  enabled: boolean;
  source: "saved" | "environment" | "none";
  /** Masked identifier, e.g. "…/webhooks/1234…". Never includes the token. */
  preview: string | null;
}

export function getPublicWebhookState(): PublicWebhookState {
  const stored = load();
  if (stored.url) {
    const m = PATH_RE.exec(new URL(stored.url).pathname);
    return {
      configured: true,
      enabled: stored.enabled,
      source: "saved",
      preview: m ? `webhooks/${m[1]!.slice(0, 4)}…` : null,
    };
  }
  if (envUrl()) return { configured: true, enabled: true, source: "environment", preview: null };
  return { configured: false, enabled: false, source: "none", preview: null };
}

export function saveWebhook(update: { url?: string; enabled?: boolean }):
  { ok: true } | { ok: false; error: string } {
  const current = load();
  let url = current.url;
  if (update.url !== undefined) {
    if (update.url.trim() === "") {
      url = null;
    } else {
      const v = validateWebhookUrl(update.url);
      if (!v.ok) return v;
      url = v.url;
    }
  }
  const enabled = url ? (update.enabled ?? (update.url !== undefined ? true : current.enabled)) : false;
  persist({ url, enabled });
  return { ok: true };
}

export function clearWebhook(): void {
  persist({ url: null, enabled: false });
}

export async function sendWebhookPayload(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) logger.warn({ status: res.status }, "Discord webhook rejected payload");
    return res.ok;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Discord webhook request failed");
    return false;
  }
}

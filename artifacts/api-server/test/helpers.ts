/**
 * Test bootstrap: starts the mock Xbox, points the app at it via
 * XBOX_MOCK_BASE, and runs the app from a fresh temp directory so auth,
 * sniper and webhook files never touch the repo. Must run before any
 * src/ module is imported (node --test runs each file in its own process).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockXbox } from "./mock-xbox";

export async function setup(opts: { account?: boolean; refreshToken?: string } = {}) {
  const mock = await startMockXbox(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-test-"));
  process.chdir(dir);
  process.env["XBOX_MOCK_BASE"] = mock.url;
  process.env["LOG_LEVEL"] ??= "silent";
  // No pino-pretty worker thread in tests.
  process.env["NODE_ENV"] = "production";
  process.env["XBOX_RESERVE_TIMEOUT_MS"] ??= "1500";
  process.env["XBOX_CHANGE_TIMEOUT_MS"] ??= "1500";
  delete process.env["XBOX_REFRESH_TOKEN"];
  delete process.env["DISCORD_WEBHOOK_URL"];
  if (opts.account !== false) {
    fs.writeFileSync(".xbox-auth.json", JSON.stringify({
      version: 2,
      activeAccountId: "acct-1",
      accounts: [{ id: "acct-1", xuid: null, gamertag: null, maskedEmail: "te•••@e•••.com", addedAt: Date.now(), msRefreshToken: opts.refreshToken ?? "rt-initial" }],
    }));
  }
  return { mock, dir };
}

/** Control helper for the mock's scripting API. */
export async function control(mockUrl: string, body: unknown): Promise<void> {
  await fetch(`${mockUrl}/__control/set`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** Captures Discord webhook deliveries without any network access. */
export function captureWebhooks(): Array<{ url: string; body: any }> {
  const sent: Array<{ url: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://discord.com/api/webhooks/")) {
      sent.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(null, { status: 204 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return sent;
}

export const WEBHOOK_URL = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789ABCD";

export async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 10_000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("until(): condition not met in time");
}

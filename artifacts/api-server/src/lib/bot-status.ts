/**
 * Discord remote-control bot heartbeat.
 *
 * The bot runs as a separate process and reports in over HTTP. Its status is
 * therefore known only from real heartbeats: no heartbeat means UNKNOWN, a
 * stale heartbeat means OFFLINE, and a fresh one means ONLINE.
 */

const FRESH_MS = 90_000;

let lastSeen: number | null = null;
let guilds: number | null = null;

export function recordBotHeartbeat(input: { guilds?: unknown }): void {
  lastSeen = Date.now();
  guilds = typeof input.guilds === "number" && Number.isInteger(input.guilds) && input.guilds >= 0 && input.guilds < 10_000
    ? input.guilds
    : null;
}

export type BotState = "online" | "offline" | "unknown";

export function getBotStatus(now = Date.now()): { state: BotState; detail: string } {
  if (lastSeen === null) return { state: "unknown", detail: "No heartbeat received" };
  const age = now - lastSeen;
  if (age <= FRESH_MS) {
    return { state: "online", detail: guilds === null ? "Connected" : `Connected to ${guilds} server${guilds === 1 ? "" : "s"}` };
  }
  const minutes = Math.max(1, Math.round(age / 60_000));
  return { state: "offline", detail: `Last heartbeat ${minutes} min ago` };
}

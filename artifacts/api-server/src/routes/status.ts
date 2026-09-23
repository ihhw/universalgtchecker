import { Router, type IRouter } from "express";
import { getActiveAccountStatus, isAuthenticated, isXstsReady } from "../lib/xbox-auth";
import { sniperStats } from "../lib/xbox-sniper";
import { activityClientCount } from "../lib/activity";
import { getBotStatus } from "../lib/bot-status";
import { getSessionStats } from "./gamertag";

const router: IRouter = Router();

type ServiceState = "online" | "degraded" | "offline" | "unknown";

interface ServiceStatus {
  id: string;
  label: string;
  state: ServiceState;
  detail: string;
}

// The Xbox CDN probe is a real outbound request, so cache it briefly rather
// than hitting Xbox on every status-page poll.
let cdnCache: { at: number; state: ServiceState; detail: string } | null = null;
const CDN_TTL_MS = 30_000;

async function probeXboxCdn(): Promise<{ state: ServiceState; detail: string }> {
  if (cdnCache && Date.now() - cdnCache.at < CDN_TTL_MS) return cdnCache;
  let result: { state: ServiceState; detail: string };
  try {
    const started = Date.now();
    // Any HTTP response (200 taken / 401 / 404 available) proves the CDN is
    // reachable; only a network failure or timeout is a problem.
    await fetch("https://avatar-ssl.xboxlive.com/avatar/statusprobe/avatar-body.png", {
      method: "GET",
      signal: AbortSignal.timeout(4_000),
    });
    result = { state: "online", detail: `Reachable, ${Date.now() - started} ms` };
  } catch {
    result = { state: "offline", detail: "Unreachable from the server" };
  }
  cdnCache = { at: Date.now(), ...result };
  return result;
}

function formatUptime(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** GET /api/status — verified state of each service; UNKNOWN when unverifiable. */
router.get("/status", async (_req, res): Promise<void> => {
  const cdn = await probeXboxCdn();
  const authed = isAuthenticated();
  const stats = getSessionStats();

  let xbox: ServiceStatus;
  if (cdn.state === "offline") {
    xbox = { id: "xbox", label: "Xbox API", state: "offline", detail: cdn.detail };
  } else if (authed && isXstsReady()) {
    xbox = { id: "xbox", label: "Xbox API", state: "online", detail: "Signed in" };
  } else if (authed) {
    const acct = getActiveAccountStatus();
    xbox = { id: "xbox", label: "Xbox API", state: "degraded", detail: `Signed in, not ready: ${acct.reason ?? "token refresh pending"}` };
  } else {
    xbox = { id: "xbox", label: "Xbox API", state: "degraded", detail: "Not signed in, using CDN fallback" };
  }

  const services: ServiceStatus[] = [
    { id: "api", label: "API", state: "online", detail: `Up ${formatUptime(process.uptime())}` },
    xbox,
    {
      id: "engine",
      label: "Checker engine",
      state: "online",
      detail: `${stats.running} search${stats.running === 1 ? "" : "es"} running${sniperStats().running ? " · sniper watching" : ""}`,
    },
    {
      id: "realtime",
      label: "Realtime",
      state: "online",
      detail: `${stats.sseClients + activityClientCount()} stream${stats.sseClients + activityClientCount() === 1 ? "" : "s"} connected`,
    },
    { id: "bot", label: "Discord bot", ...getBotStatus() },
  ];

  res.json({ checkedAt: Date.now(), services });
});

export default router;

import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { listActivity, activityClientCount } from "../lib/activity";
import { listClaims } from "../lib/xbox-claim";
import { getAccountInfoList } from "../lib/xbox-auth";
import { listSniperSnapshots } from "../lib/xbox-sniper";
import { getWebhookTarget } from "../lib/webhook-store";
import { getSessionStats } from "./gamertag";
import { getBotStatus } from "../lib/bot-status";
import { getStats } from "../lib/stats";

const router: IRouter = Router();

const START_TIME = Date.now();

/**
 * GET /api/diagnostics — internal debug info for developers/operators.
 * Every field is a real, live number read from the running process and its
 * in-memory/persisted state at request time; nothing here is estimated.
 * No secrets: env vars are reported present/absent, never with their value.
 */
router.get("/diagnostics", (_req, res): void => {
  const mem = process.memoryUsage();
  const checker = getSessionStats();
  const sniperTargets = listSniperSnapshots();
  const activeSniperTargets = sniperTargets.filter((t) => t.state === "watching" || t.state === "claiming").length;

  res.json({
    process: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeMs: Date.now() - START_TIME,
      env: process.env["NODE_ENV"] ?? "development",
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      },
    },
    config: {
      xboxClientIdSet: !!process.env["XBOX_CLIENT_ID"],
      xboxMockBase: !!process.env["XBOX_MOCK_BASE"],
      logLevel: process.env["LOG_LEVEL"] ?? (process.env["NODE_ENV"] === "production" ? "info" : "debug"),
      discordWebhookConfigured: getWebhookTarget() !== null,
    },
    buffers: {
      activityEvents: listActivity(0, 100_000).length,
      activityHits: listActivity(0, 100_000, true).length,
      activityStreamClients: activityClientCount(),
      claimRecords: listClaims(0).length,
    },
    checker,
    sniper: { totalTargets: sniperTargets.length, activeTargets: activeSniperTargets },
    accounts: { total: getAccountInfoList().length, ready: getAccountInfoList().filter((a) => a.readiness.ready).length },
    bot: getBotStatus(),
    analyticsTotals: getStats(1).totals,
  });
});

/** POST /api/diagnostics/test-webhook — sends a real, clearly-labeled test message. */
router.post("/diagnostics/test-webhook", async (_req, res): Promise<void> => {
  const url = getWebhookTarget();
  if (!url) { res.status(400).json({ ok: false, error: "No Discord webhook is configured in Settings." }); return; }
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "Universal Checker — Diagnostics test",
          description: "This is a test message sent from the Diagnostics page. If you can see this, the webhook is configured correctly.",
          color: 0x6f6a63,
          timestamp: new Date().toISOString(),
        }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) { res.status(502).json({ ok: false, error: `Discord returned HTTP ${r.status}.` }); return; }
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Diagnostics webhook test failed");
    res.status(502).json({ ok: false, error: "Could not reach Discord (network error)." });
  }
});

export default router;

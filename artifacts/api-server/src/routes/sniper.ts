import { Router, type IRouter } from "express";
import {
  eventsAfter,
  getSniperSnapshot,
  startSniper,
  stopSniper,
  subscribeSniper,
  updateSniperSettings,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  type SniperConfig,
} from "../lib/xbox-sniper";

/**
 * Xbox Sniper API. The snapshot (GET /xbox/sniper) is authoritative and is
 * what the UI polls; the SSE stream pushes the same snapshot plus activity
 * events in real time and is safe to lose at any moment.
 */
const router: IRouter = Router();

router.get("/xbox/sniper", (req, res): void => {
  const after = Number(req.query["after"]);
  const snap = getSniperSnapshot();
  res.json({
    ...snap,
    // With ?after=<seq> only newer events are returned (cheap incremental polls).
    events: Number.isFinite(after) ? eventsAfter(after) : snap.events,
    limits: { minIntervalMs: MIN_INTERVAL_MS, maxIntervalMs: MAX_INTERVAL_MS },
  });
});

router.post("/xbox/sniper/start", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Partial<SniperConfig>;
  const r = await startSniper({
    target: body.target,
    intervalMs: body.intervalMs,
    autoClaim: body.autoClaim,
    notifications: body.notifications,
    doubleCheck: body.doubleCheck,
  });
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
  res.status(201).json(getSniperSnapshot());
});

router.post("/xbox/sniper/stop", (_req, res): void => {
  const stopped = stopSniper();
  res.json({ stopped, ...getSniperSnapshot() });
});

router.patch("/xbox/sniper/settings", (req, res): void => {
  const body = (req.body ?? {}) as { autoClaim?: unknown; notifications?: unknown };
  const config = updateSniperSettings({
    autoClaim: typeof body.autoClaim === "boolean" ? body.autoClaim : undefined,
    notifications: typeof body.notifications === "boolean" ? body.notifications : undefined,
  });
  res.json({ config });
});

router.get("/xbox/sniper/stream", (req, res): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const write = (kind: string, data: unknown) => {
    res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  write("snapshot", getSniperSnapshot(50));
  const unsubscribe = subscribeSniper(write);
  // Comment heartbeat keeps proxies from closing an idle stream.
  const heartbeat = setInterval(() => { res.write(": ping\n\n"); }, 15_000);
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
});

export default router;

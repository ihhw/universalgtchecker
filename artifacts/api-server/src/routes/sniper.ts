import { Router, type IRouter } from "express";
import {
  eventsAfter,
  getSniperSnapshot,
  listSniperSnapshots,
  removeSniper,
  startSniper,
  stopSniper,
  subscribeSniper,
  updateSniperSettings,
  MAX_TARGETS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  type SniperConfig,
} from "../lib/xbox-sniper";

/**
 * Xbox Sniper API. Multiple targets can watch concurrently, each addressed
 * by its own id. GET /xbox/sniper (the list) is authoritative and is what
 * the UI polls; the SSE stream pushes the same snapshots plus activity
 * events in real time and is safe to lose at any moment.
 */
const router: IRouter = Router();

const LIMITS = { minIntervalMs: MIN_INTERVAL_MS, maxIntervalMs: MAX_INTERVAL_MS, maxTargets: MAX_TARGETS };

router.get("/xbox/sniper", (_req, res): void => {
  res.json({ targets: listSniperSnapshots(), limits: LIMITS });
});

router.post("/xbox/sniper/targets", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Partial<SniperConfig>;
  const r = await startSniper({
    target: body.target,
    intervalMs: body.intervalMs,
    autoClaim: body.autoClaim,
    notifications: body.notifications,
    doubleCheck: body.doubleCheck,
  });
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
  res.status(201).json(getSniperSnapshot(r.id));
});

router.post("/xbox/sniper/targets/:id/stop", (req, res): void => {
  const stopped = stopSniper(req.params.id);
  const snap = getSniperSnapshot(req.params.id);
  if (!snap) { res.status(404).json({ error: "Target not found." }); return; }
  res.json({ stopped, ...snap });
});

router.delete("/xbox/sniper/targets/:id", (req, res): void => {
  const removed = removeSniper(req.params.id);
  if (!removed) { res.status(404).json({ error: "Target not found." }); return; }
  res.status(204).end();
});

router.patch("/xbox/sniper/targets/:id/settings", (req, res): void => {
  const body = (req.body ?? {}) as { autoClaim?: unknown; notifications?: unknown };
  const config = updateSniperSettings(req.params.id, {
    autoClaim: typeof body.autoClaim === "boolean" ? body.autoClaim : undefined,
    notifications: typeof body.notifications === "boolean" ? body.notifications : undefined,
  });
  if (!config) { res.status(404).json({ error: "Target not found." }); return; }
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
  write("snapshot", { targets: listSniperSnapshots(50) });
  const unsubscribe = subscribeSniper(write);
  // Comment heartbeat keeps proxies from closing an idle stream.
  const heartbeat = setInterval(() => { res.write(": ping\n\n"); }, 15_000);
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
});

// Kept last: a wildcard-ish /:id would otherwise shadow the literal routes above.
router.get("/xbox/sniper/:id", (req, res): void => {
  const after = Number(req.query["after"]);
  const snap = getSniperSnapshot(req.params.id);
  if (!snap) { res.status(404).json({ error: "Target not found." }); return; }
  res.json({
    ...snap,
    events: Number.isFinite(after) ? eventsAfter(req.params.id, after) : snap.events,
    limits: LIMITS,
  });
});

export default router;

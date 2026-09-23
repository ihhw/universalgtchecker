import { Router, type IRouter } from "express";
import { addActivityClient, latestActivityId, listActivity } from "../lib/activity";

const router: IRouter = Router();

/**
 * GET /api/activity?after=<id>[&only=hits]
 * Recent real checker events, oldest first. `only=hits` returns just the
 * alertable available results, from a separate buffer that fast traffic
 * cannot evict.
 */
router.get("/activity", (req, res): void => {
  const after = Number.parseInt(String(req.query["after"] ?? "0"), 10);
  const onlyHits = req.query["only"] === "hits";
  const events = listActivity(Number.isFinite(after) && after > 0 ? after : 0, 200, onlyHits);
  res.json({ events, latestId: latestActivityId() });
});

/** GET /api/activity/stream — SSE enhancement over the polling endpoint. */
router.get("/activity/stream", (req, res): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  const remove = addActivityClient(res);
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* closed */ }
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    remove();
  });
});

export default router;

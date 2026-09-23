import { Router, type IRouter } from "express";
import { getStats } from "../lib/stats";

const router: IRouter = Router();

/** GET /api/analytics?days=30 — real, persisted day-bucketed counters. */
router.get("/analytics", (req, res): void => {
  const daysParam = Number(req.query["days"]);
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.floor(daysParam) : 30;
  res.json(getStats(days));
});

export default router;

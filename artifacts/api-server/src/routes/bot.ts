import { Router, type IRouter } from "express";
import { recordBotHeartbeat } from "../lib/bot-status";

const router: IRouter = Router();

/** POST /api/bot/heartbeat: sent periodically by the Discord remote-control bot. */
router.post("/bot/heartbeat", (req, res): void => {
  const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as { guilds?: unknown };
  recordBotHeartbeat(body);
  res.json({ ok: true });
});

export default router;

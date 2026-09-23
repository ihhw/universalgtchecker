import { Router, type IRouter } from "express";
import { listAudit, logAudit, type AuditEvent } from "../lib/audit";

const router: IRouter = Router();

/** GET /api/audit?after=<id> — the account/claim audit trail. */
router.get("/audit", (req, res): void => {
  const after = Number.parseInt(String(req.query["after"] ?? "0"), 10);
  res.json({ entries: listAudit(Number.isFinite(after) && after > 0 ? after : 0) });
});

// Only these three events originate purely client-side (the user filling out
// Microsoft's own signup form — the server has no way to observe that
// directly). Everything else is logged server-side, at the real state
// transition, and can never be injected through this endpoint.
const CLIENT_EVENTS: ReadonlySet<AuditEvent> = new Set([
  "ACCOUNT_CREATION_STARTED",
  "ACCOUNT_CREATION_AWAITING_USER",
  "ACCOUNT_CREATION_CONFIRMED",
]);

router.post("/audit/client", (req, res): void => {
  const event = (req.body as { event?: unknown } | undefined)?.event;
  if (typeof event !== "string" || !CLIENT_EVENTS.has(event as AuditEvent)) {
    res.status(400).json({ error: "Unsupported client audit event." });
    return;
  }
  logAudit(event as AuditEvent, {});
  res.status(204).end();
});

export default router;

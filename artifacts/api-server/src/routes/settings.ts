import { Router, type IRouter } from "express";
import {
  clearWebhook,
  getPublicWebhookState,
  getWebhookTarget,
  saveWebhook,
  sendWebhookPayload,
} from "../lib/webhook-store";

const router: IRouter = Router();

/** Manual body validation (keeps the route free of extra dependencies). */
function parseWebhookBody(body: unknown): { url?: string; enabled?: boolean } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const out: { url?: string; enabled?: boolean } = {};
  if (raw["url"] !== undefined) {
    if (typeof raw["url"] !== "string" || raw["url"].length > 400) return null;
    out.url = raw["url"];
  }
  if (raw["enabled"] !== undefined) {
    if (typeof raw["enabled"] !== "boolean") return null;
    out.enabled = raw["enabled"];
  }
  return out;
}

/** GET /api/settings/webhook — masked state; the URL itself is never returned. */
router.get("/settings/webhook", (_req, res): void => {
  res.json(getPublicWebhookState());
});

/** PUT /api/settings/webhook — validate and save the webhook server-side. */
router.put("/settings/webhook", (req, res): void => {
  const parsed = parseWebhookBody(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Invalid request body." });
    return;
  }
  const result = saveWebhook(parsed);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(getPublicWebhookState());
});

/** DELETE /api/settings/webhook — remove the saved webhook. */
router.delete("/settings/webhook", (_req, res): void => {
  clearWebhook();
  res.json(getPublicWebhookState());
});

/**
 * POST /api/settings/webhook/test — sends a clearly-labelled test message.
 * This is not an availability alert and contains no username.
 */
router.post("/settings/webhook/test", async (_req, res): Promise<void> => {
  const target = getWebhookTarget();
  if (!target) {
    res.status(400).json({ error: "No enabled webhook is configured." });
    return;
  }
  const ok = await sendWebhookPayload(target, {
    username: "Universal Checker",
    content: "Webhook connected. This is a test message, not an availability alert.",
  });
  if (!ok) {
    res.status(502).json({ error: "Discord did not accept the test message." });
    return;
  }
  res.json({ success: true });
});

export default router;

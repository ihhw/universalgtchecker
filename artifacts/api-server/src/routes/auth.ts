import { Router, type IRouter } from "express";
import {
  startDeviceCodeFlow,
  getDeviceCodeState,
  isAuthenticated,
  isXstsReady,
  logoutAllAccounts,
} from "../lib/xbox-auth";

const router: IRouter = Router();

/** GET /api/auth/xbox/status — current auth state */
router.get("/auth/xbox/status", (_req, res): void => {
  const state = getDeviceCodeState();
  res.json({
    authenticated: isAuthenticated(),
    xstsReady:     isXstsReady(),
    deviceCode: state
      ? {
          userCode:        state.userCode,
          verificationUri: state.verificationUri,
          status:          state.status,
          expiresAt:       state.expiresAt,
        }
      : null,
  });
});

/** POST /api/auth/xbox/start — begin device code flow */
router.post("/auth/xbox/start", async (req, res): Promise<void> => {
  try {
    const state = await startDeviceCodeFlow();
    res.json({
      userCode:        state.userCode,
      verificationUri: state.verificationUri,
      expiresAt:       state.expiresAt,
      status:          state.status,
    });
  } catch (err) {
    const message = String(err);
    req.log.error({ err: message }, "Device code flow failed");
    res.status(500).json({ error: message });
  }
});

/** POST /api/auth/xbox/logout — sign out all accounts */
router.post("/auth/xbox/logout", (req, res): void => {
  logoutAllAccounts();
  req.log.info("Xbox accounts signed out via API");
  res.json({ success: true, authenticated: false });
});

export default router;

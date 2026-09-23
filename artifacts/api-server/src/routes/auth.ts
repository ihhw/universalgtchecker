import { Router, type IRouter } from "express";
import {
  startDeviceCodeFlow,
  getDeviceCodeState,
  getActiveAccountStatus,
  getAccountInfoList,
  setActiveAccount,
  removeAccount,
  isAuthenticated,
  isXstsReady,
  logoutAllAccounts,
  verifyActiveAccount,
} from "../lib/xbox-auth";

const router: IRouter = Router();

/**
 * GET /api/auth/xbox/status — current auth state.
 *
 * `authenticated` only means a Microsoft sign-in exists. `account.ready` is
 * true only when the whole chain (Microsoft → Xbox Live → XSTS → XUID)
 * succeeded; otherwise `account.reason` says which link failed. No token is
 * ever included — only a masked email, the gamertag and a masked XUID.
 */
router.get("/auth/xbox/status", (_req, res): void => {
  const state = getDeviceCodeState();
  res.json({
    authenticated: isAuthenticated(),
    xstsReady:     isXstsReady(),
    account:       getActiveAccountStatus(),
    deviceCode: state
      ? {
          userCode:        state.userCode,
          verificationUri: state.verificationUri,
          status:          state.status,
          expiresAt:       state.expiresAt,
          error:           state.error,
        }
      : null,
  });
});

/** POST /api/auth/xbox/verify — run the auth chain now and report readiness. */
router.post("/auth/xbox/verify", async (_req, res): Promise<void> => {
  const account = await verifyActiveAccount();
  res.json({ authenticated: isAuthenticated(), xstsReady: isXstsReady(), account });
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

/**
 * GET /api/auth/xbox/accounts — every signed-in Xbox account (Account Manager).
 * Display-safe: masked email/XUID, gamertag, readiness — never a token.
 */
router.get("/auth/xbox/accounts", (_req, res): void => {
  res.json({ accounts: getAccountInfoList() });
});

/** POST /api/auth/xbox/accounts/:id/activate — switch which account claims run as. */
router.post("/auth/xbox/accounts/:id/activate", (req, res): void => {
  const ok = setActiveAccount(req.params.id);
  if (!ok) { res.status(404).json({ error: "Account not found." }); return; }
  res.json({ accounts: getAccountInfoList(), account: getActiveAccountStatus() });
});

/** DELETE /api/auth/xbox/accounts/:id — forget one account (the others are untouched). */
router.delete("/auth/xbox/accounts/:id", (req, res): void => {
  const ok = removeAccount(req.params.id);
  if (!ok) { res.status(404).json({ error: "Account not found." }); return; }
  res.json({ accounts: getAccountInfoList(), account: getActiveAccountStatus() });
});

export default router;

/**
 * Xbox Live authentication — multi-account via OAuth2 device code flow.
 *
 * Multiple accounts can be signed in simultaneously. One account is designated
 * "active" and used for gamertag claim/change operations.
 * Any authenticated account (defaulting to active) is used for availability checks.
 *
 * Chain (all server-side; no token ever reaches the browser):
 *   Microsoft device code sign-in  → MS refresh token (+ id_token for the email)
 *   MS access token                → Xbox Live user token (user.auth.xboxlive.com)
 *   Xbox Live user token           → XSTS token, relying party http://xboxlive.com
 *   XSTS DisplayClaims.xui[0]      → uhs (user hash), xid (XUID), gtg (gamertag)
 *
 * The same http://xboxlive.com XSTS token authorizes both the availability
 * checks and the gamertag.xboxlive.com reserve/change (claim) calls. XSTS
 * tokens are bound to their relying party, so a token minted for
 * http://accounts.xboxlive.com is rejected by gamertag.xboxlive.com.
 *
 * Storage: .xbox-auth.json (v2 format)
 *   { version: 2, accounts: StoredAccount[], activeAccountId: string | null }
 * Legacy v1 format ({ refreshToken }) is auto-migrated on first load.
 * Only the refresh token, XUID, gamertag and a MASKED email are stored.
 */

import { logger } from "./logger";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { xboxUrl } from "./xbox-http";
import { logAudit } from "./audit";

// App registration "GT hinter". The client ID is a public identifier (not a
// secret) and is kept on the server. Override with XBOX_CLIENT_ID.
const DEFAULT_CLIENT_ID = "94028da3-aa0c-4c46-b5ec-ac40baaba225";
const CLIENT_ID = process.env["XBOX_CLIENT_ID"]?.trim() || DEFAULT_CLIENT_ID;
// "consumers" is required for personal Microsoft accounts (Xbox Live). Set
// XBOX_TENANT_ID only if the app registration is restricted to one tenant.
const TENANT    = process.env["XBOX_TENANT_ID"]?.trim() || "consumers";
const SCOPE     = "XboxLive.signin offline_access";
// Sign-in additionally asks for the standard OpenID scopes so the id_token
// carries the account's email, shown masked in the UI. Refreshes only need
// the Xbox scope.
const SIGNIN_SCOPE = `${SCOPE} openid profile email`;

const TOKEN_URL      = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const DEVICECODE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`;
const XBL_AUTH_URL   = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL       = "https://xsts.auth.xboxlive.com/xsts/authorize";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Which link of the chain failed (or "ready" when the whole chain succeeded). */
export type AuthStage = "none" | "microsoft" | "xbox_live" | "xsts" | "xuid" | "ready";

export interface Readiness {
  ready:     boolean;
  stage:     AuthStage;
  /** Human-readable reason when not ready. Never contains a token. */
  reason:    string | null;
  /** Xbox XErr code or Microsoft error code, when one was returned. */
  code:      string | null;
  checkedAt: number | null;
}

export interface AccountInfo {
  id:          string;
  xuid:        string | null;
  gamertag:    string | null;
  maskedEmail: string | null;
  addedAt:     number;  // epoch ms
  isActive:    boolean;
  xstsReady:   boolean;
  readiness:   Readiness;
}

interface AccountState {
  id:              string;
  msRefreshToken:  string;
  xuid:            string | null;
  gamertag:        string | null;
  maskedEmail:     string | null;
  addedAt:         number;
  /** Refresh token was rejected (invalid_grant); the user must sign in again. */
  revoked:         boolean;
  // Xbox Live user token — cached so an XSTS re-issue (e.g. to confirm a
  // claim) doesn't need a Microsoft refresh.
  xblToken:        string | null;
  xblExpiry:       number;
  // XSTS (http://xboxlive.com) — availability checks AND gamertag claims
  xstsToken:       string | null;
  xstsExpiry:      number;
  uhs:             string | null;
  readiness:       Readiness;
}

// ─── In-memory store ──────────────────────────────────────────────────────────

const accounts       = new Map<string, AccountState>();
let activeAccountId: string | null = null;

// Per-account in-flight promise — prevents concurrent MS token refreshes.
// Microsoft refresh tokens are single-use; a second concurrent use invalidates the first.
const inFlight = new Map<string, Promise<{ token: string; uhs: string } | null>>();

// ─── Masking ──────────────────────────────────────────────────────────────────

/** "john.doe@outlook.com" → "jo•••@o•••.com". Never returns the full address. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes("@")) return null;
  const [local = "", domain = ""] = email.split("@");
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  const l = local.length <= 2 ? `${local.slice(0, 1)}•••` : `${local.slice(0, 2)}•••`;
  return `${l}@${host.slice(0, 1)}•••${tld}`;
}

/** "2533274812345678" → "2533••••••••5678". */
export function maskXuid(xuid: string | null | undefined): string | null {
  if (!xuid) return null;
  if (xuid.length <= 8) return "••••" + xuid.slice(-2);
  return `${xuid.slice(0, 4)}${"•".repeat(Math.max(4, xuid.length - 8))}${xuid.slice(-4)}`;
}

function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    // The id_token came straight from Microsoft's token endpoint over TLS, so
    // its claims can be read without separate signature validation (OIDC
    // Core §3.1.3.7). Only the email is used, and only in masked form.
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      email?: string; preferred_username?: string;
    };
    return payload.email ?? payload.preferred_username ?? null;
  } catch {
    return null;
  }
}

// ─── Xbox error codes ─────────────────────────────────────────────────────────

const XERR_REASONS: Record<string, string> = {
  "2148916227": "This Xbox account is banned or suspended by Xbox.",
  "2148916229": "Parental controls block this account from using Xbox Live online.",
  "2148916233": "This Microsoft account has no Xbox profile yet. Sign in once at xbox.com to create one, then reconnect.",
  "2148916234": "This account must accept the Xbox terms of use. Sign in at xbox.com, accept, then reconnect.",
  "2148916235": "Xbox Live is not available in this account's country/region.",
  "2148916236": "This account needs adult (age) verification before it can use Xbox Live.",
  "2148916237": "This account needs age verification before it can use Xbox Live.",
  "2148916238": "This is a child account. An adult must add it to a Microsoft family before it can use Xbox Live.",
};

function parseXErr(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as { XErr?: number | string };
    return body.XErr !== undefined ? String(body.XErr) : null;
  } catch { return null; /* no JSON body */ }
}

function describeXboxAuthFailure(res: { status: number }, bodyText: string, what: string): { reason: string; code: string | null } {
  const xerr = parseXErr(bodyText);
  if (xerr && XERR_REASONS[xerr]) return { reason: XERR_REASONS[xerr]!, code: xerr };
  return {
    reason: `${what} was refused by Xbox (HTTP ${res.status}${xerr ? `, XErr ${xerr}` : ""}).`,
    code: xerr,
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const AUTH_FILE = path.join(process.cwd(), ".xbox-auth.json");

interface StoredV2 {
  version:         2;
  accounts:        StoredAccount[];
  activeAccountId: string | null;
}

interface StoredAccount {
  id:             string;
  xuid:           string | null;
  gamertag:       string | null;
  maskedEmail?:   string | null;
  addedAt:        number;
  msRefreshToken: string;
}

function persistAccounts(): void {
  try {
    const data: StoredV2 = {
      version: 2,
      activeAccountId,
      accounts: [...accounts.values()].filter((a) => !a.revoked).map((a) => ({
        id:             a.id,
        xuid:           a.xuid,
        gamertag:       a.gamertag,
        maskedEmail:    a.maskedEmail,
        addedAt:        a.addedAt,
        msRefreshToken: a.msRefreshToken,
      })),
    };
    // 0600: the file holds refresh tokens.
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch { /* non-critical */ }
}

const NOT_CHECKED: Readiness = { ready: false, stage: "none", reason: "Not verified yet.", code: null, checkedAt: null };

function makeAccount(
  id: string,
  msRefreshToken: string,
  addedAt: number,
  xuid:        string | null = null,
  gamertag:    string | null = null,
  maskedEmail: string | null = null,
): AccountState {
  return {
    id, msRefreshToken, addedAt, xuid, gamertag, maskedEmail, revoked: false,
    xblToken: null, xblExpiry: 0,
    xstsToken: null, xstsExpiry: 0, uhs: null,
    readiness: { ...NOT_CHECKED },
  };
}

function loadAccounts(): void {
  // Env secret takes precedence for legacy single-account bootstrap
  const envToken = process.env["XBOX_REFRESH_TOKEN"];

  try {
    const raw  = fs.readFileSync(AUTH_FILE, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;

    // v1 migration: { refreshToken: string }
    if (!data["version"] && typeof data["refreshToken"] === "string") {
      const token = envToken ?? (data["refreshToken"] as string);
      const id    = "legacy";
      accounts.set(id, makeAccount(id, token, Date.now()));
      activeAccountId = id;
      logger.info("Migrated legacy single-account auth to v2 multi-account format");
      persistAccounts();
      return;
    }

    // v2 format
    if (data["version"] === 2) {
      const v2 = data as unknown as StoredV2;
      for (const stored of v2.accounts) {
        accounts.set(stored.id, makeAccount(
          stored.id, stored.msRefreshToken, stored.addedAt, stored.xuid, stored.gamertag, stored.maskedEmail ?? null,
        ));
      }
      activeAccountId = v2.activeAccountId ?? null;
      // Sanitise: if saved activeAccountId is gone, fall back to first account
      if (activeAccountId && !accounts.has(activeAccountId)) {
        activeAccountId = accounts.keys().next().value ?? null;
      }
    }
  } catch {
    // File missing or corrupt — bootstrap from env secret if available
    if (envToken) {
      const id = "legacy";
      accounts.set(id, makeAccount(id, envToken, Date.now()));
      activeAccountId = id;
    }
  }
}

loadAccounts();

function setReadiness(account: AccountState, stage: AuthStage, reason: string | null, code: string | null = null): void {
  account.readiness = { ready: stage === "ready", stage, reason, code, checkedAt: Date.now() };
}

// ─── Microsoft token refresh ──────────────────────────────────────────────────

async function refreshMsToken(account: AccountState): Promise<string | null> {
  if (account.revoked) {
    setReadiness(account, "microsoft", "Microsoft sign-in expired or was revoked. Connect Xbox again.", "invalid_grant");
    return null;
  }
  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    grant_type:    "refresh_token",
    refresh_token: account.msRefreshToken,
    scope:         SCOPE,
  });

  try {
    const res = await fetch(
      xboxUrl(TOKEN_URL),
      {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal:  AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        let errCode = "";
        try {
          const errData = (await res.json()) as { error?: string };
          errCode = errData.error ?? "";
        } catch { /* ignore */ }

        if (errCode === "invalid_grant" || errCode === "expired_token") {
          // Keep the account (without its dead token on disk) so the UI can
          // say exactly why it is not ready; a new sign-in replaces it.
          logger.warn({ accountId: account.id, error: errCode }, "MS refresh token revoked — account needs a new sign-in");
          account.revoked = true;
          account.xstsToken = null;
          account.xblToken = null;
          persistAccounts();
          setReadiness(account, "microsoft", "Microsoft sign-in expired or was revoked. Connect Xbox again.", errCode);
          logAudit("ACCOUNT_REFRESH_FAILED", { accountId: account.id, errorCode: errCode });
        } else {
          logger.warn({ accountId: account.id, status: res.status, error: errCode }, "MS token refresh rejected — retaining for retry");
          setReadiness(account, "microsoft", `Microsoft rejected the token refresh (HTTP ${res.status}${errCode ? `, ${errCode}` : ""}).`, errCode || null);
        }
      } else {
        logger.warn({ accountId: account.id, status: res.status }, "MS token refresh server error (transient) — retaining");
        setReadiness(account, "microsoft", `Microsoft sign-in service error (HTTP ${res.status}). Will retry.`);
      }
      return null;
    }

    const data = (await res.json()) as { access_token: string; refresh_token: string };
    account.msRefreshToken = data.refresh_token;
    persistAccounts();
    logger.info({ accountId: account.id }, "MS refresh token rotated and persisted");
    return data.access_token;
  } catch (err) {
    logger.warn({ accountId: account.id, errName: err instanceof Error ? err.name : "unknown" }, "MS token refresh network error — retaining");
    setReadiness(account, "microsoft", "Could not reach Microsoft sign-in (network error). Will retry.");
    return null;
  }
}

// ─── Xbox Live user token ─────────────────────────────────────────────────────

async function getXblToken(account: AccountState, allowCached: boolean): Promise<string | null> {
  if (allowCached && account.xblToken && Date.now() < account.xblExpiry - 5 * 60_000) return account.xblToken;

  const msToken = await refreshMsToken(account);
  if (!msToken) return null;

  try {
    const xblRes = await fetch(xboxUrl(XBL_AUTH_URL), {
      method:  "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-xbl-contract-version": "1" },
      body: JSON.stringify({
        Properties:   { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${msToken}` },
        RelyingParty: "http://auth.xboxlive.com",
        TokenType:    "JWT",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!xblRes.ok) {
      const { reason, code } = describeXboxAuthFailure(xblRes, await xblRes.text().catch(() => ""), "Xbox Live sign-in");
      account.xblToken = null;
      account.xstsToken = null;
      logger.warn({ accountId: account.id, status: xblRes.status, code }, "XBL auth failed");
      setReadiness(account, "xbox_live", reason, code);
      return null;
    }
    const xblData = (await xblRes.json()) as { Token?: string; NotAfter?: string };
    if (!xblData.Token) {
      setReadiness(account, "xbox_live", "Xbox Live sign-in returned no token.");
      return null;
    }
    account.xblToken  = xblData.Token;
    account.xblExpiry = xblData.NotAfter ? new Date(xblData.NotAfter).getTime() : Date.now() + 60 * 60_000;
    return account.xblToken;
  } catch (err) {
    logger.warn({ accountId: account.id, errName: err instanceof Error ? err.name : "unknown" }, "XBL auth network error");
    setReadiness(account, "xbox_live", "Could not reach Xbox Live sign-in (network error). Will retry.");
    return null;
  }
}

// ─── XSTS fetch ───────────────────────────────────────────────────────────────

async function _doFetchXsts(account: AccountState, allowCachedXbl = true): Promise<{ token: string; uhs: string } | null> {
  let xblToken = await getXblToken(account, allowCachedXbl);
  if (!xblToken) return null;

  try {
    const requestXsts = (userToken: string) => fetch(xboxUrl(XSTS_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-xbl-contract-version": "1" },
      body: JSON.stringify({
        Properties:   { SandboxId: "RETAIL", UserTokens: [userToken] },
        RelyingParty: "http://xboxlive.com",
        TokenType:    "JWT",
      }),
      signal: AbortSignal.timeout(10_000),
    });

    let xstsRes = await requestXsts(xblToken);
    let xstsText = xstsRes.ok ? "" : await xstsRes.text().catch(() => "");
    // A cached user token may have been invalidated server-side; retry once
    // with a freshly minted one. A 401 carrying an XErr is an account-level
    // refusal (no profile, child account, ...) that a new token can't fix.
    if (xstsRes.status === 401 && allowCachedXbl && !parseXErr(xstsText)) {
      account.xblToken = null;
      xblToken = await getXblToken(account, false);
      if (!xblToken) return null;
      xstsRes = await requestXsts(xblToken);
      xstsText = xstsRes.ok ? "" : await xstsRes.text().catch(() => "");
    }

    if (!xstsRes.ok) {
      const { reason, code } = describeXboxAuthFailure(xstsRes, xstsText, "XSTS authorization");
      // Xbox refused this account: a previously cached token must not keep
      // claims working while the account is reported as not ready.
      account.xstsToken = null;
      logger.warn({ accountId: account.id, status: xstsRes.status, code }, "XSTS auth failed (xboxlive.com)");
      setReadiness(account, "xsts", reason, code);
      return null;
    }
    const xstsData = (await xstsRes.json()) as {
      Token: string; NotAfter: string;
      DisplayClaims?: { xui?: Array<{ uhs?: string; xid?: string; gtg?: string }> };
    };
    const claims = xstsData.DisplayClaims?.xui?.[0];
    if (!xstsData.Token || !claims?.uhs) {
      setReadiness(account, "xsts", "XSTS response did not include a user hash.");
      return null;
    }
    account.xstsToken  = xstsData.Token;
    account.uhs        = claims.uhs;
    account.xstsExpiry = new Date(xstsData.NotAfter).getTime();

    // XUID and gamertag come from the XSTS display claims. They are refreshed
    // on every issue, so a successful gamertag change is reflected here.
    let changed = false;
    if (claims.xid && claims.xid !== account.xuid) { account.xuid = claims.xid; changed = true; }
    if (claims.gtg && claims.gtg !== account.gamertag) { account.gamertag = claims.gtg; changed = true; }
    if (changed) persistAccounts();

    if (!account.xuid) {
      setReadiness(account, "xuid", "Xbox did not return an XUID for this account, so it cannot claim gamertags.");
    } else {
      const wasReady = account.readiness.stage === "ready";
      setReadiness(account, "ready", null);
      if (!wasReady) logAudit("ACCOUNT_CONNECTED", { accountId: account.id, xuid: account.xuid });
    }

    logger.info({ accountId: account.id, expiresAt: xstsData.NotAfter }, "✅ XSTS token obtained — ready for Xbox API calls");
    return { token: account.xstsToken, uhs: account.uhs };
  } catch (err) {
    logger.warn({ accountId: account.id, errName: err instanceof Error ? err.name : "unknown" }, "XSTS fetch error");
    setReadiness(account, "xsts", "Could not reach Xbox XSTS (network error). Will retry.");
    return null;
  }
}

function xstsValid(a: AccountState): boolean {
  return !!(a.xstsToken && a.uhs && Date.now() < a.xstsExpiry - 5 * 60_000);
}

async function fetchXstsForAccount(id: string, force = false): Promise<{ token: string; uhs: string } | null> {
  const account = accounts.get(id);
  if (!account || account.revoked) return null;

  // Return cached if still valid (5-min buffer)
  if (!force && xstsValid(account)) {
    return { token: account.xstsToken!, uhs: account.uhs! };
  }

  const existing = inFlight.get(id);
  if (existing) return existing;

  const promise = _doFetchXsts(account).finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}

// ─── Proactive refresh ────────────────────────────────────────────────────────

setInterval(() => {
  for (const [id, account] of accounts.entries()) {
    if (account.revoked) continue;
    const needsRefresh = account.xstsExpiry === 0 || Date.now() > account.xstsExpiry - 10 * 60_000;
    if (needsRefresh && !inFlight.has(id)) {
      fetchXstsForAccount(id).catch((err) => logger.warn({ accountId: id, err }, "Proactive XSTS refresh error"));
    }
  }
}, 60_000).unref();

// ─── Device code flow ─────────────────────────────────────────────────────────

export interface DeviceCodeInfo {
  userCode:        string;
  verificationUri: string;
  expiresAt:       number;
  status:          "pending" | "authorized" | "expired" | "error";
  /** Microsoft's error code when status is "error" (e.g. access_denied). */
  error?:          string;
}

let dcState: DeviceCodeInfo | null = null;
let dcDeviceCode = "";
let dcInterval   = 5_000;

async function pollLoop(): Promise<void> {
  while (dcState?.status === "pending" && Date.now() < dcState.expiresAt) {
    await new Promise((r) => setTimeout(r, dcInterval));

    const body = new URLSearchParams({
      client_id:   CLIENT_ID,
      grant_type:  "urn:ietf:params:oauth:grant-type:device_code",
      device_code: dcDeviceCode,
    });

    try {
      const res = await fetch(
        xboxUrl(TOKEN_URL),
        {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal:  AbortSignal.timeout(10_000),
        },
      );
      const data = (await res.json()) as { error?: string; access_token?: string; refresh_token?: string; id_token?: string };

      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") { dcInterval += 5_000; continue; }
      if (data.error) {
        logger.warn({ error: data.error }, "Device code flow error");
        if (dcState) { dcState.status = "error"; dcState.error = data.error; }
        logAudit("ACCOUNT_AUTH_FAILED", { errorCode: data.error });
        return;
      }

      if (data.access_token && data.refresh_token) {
        // A new sign-in replaces any account whose Microsoft sign-in was revoked.
        for (const [oldId, old] of accounts) {
          if (old.revoked) accounts.delete(oldId);
        }
        if (activeAccountId && !accounts.has(activeAccountId)) activeAccountId = null;

        const id      = crypto.randomUUID();
        const account = makeAccount(id, data.refresh_token, Date.now(), null, null, maskEmail(emailFromIdToken(data.id_token)));
        accounts.set(id, account);

        // First account (or only one) becomes active automatically
        if (!activeAccountId) activeAccountId = id;
        persistAccounts();

        if (dcState) dcState.status = "authorized";
        logger.info({ accountId: id }, "✅ New Xbox account added");
        logAudit("ACCOUNT_AUTH_SUCCESS", { accountId: id });

        // Resolve Xbox Live → XSTS → XUID right away so readiness is known.
        fetchXstsForAccount(id).catch(() => {});
        return;
      }
    } catch { /* network blip — retry */ }
  }

  if (dcState?.status === "pending") {
    dcState.status = "expired";
    logger.warn("Device code flow expired without authorization");
  }
}

export async function startDeviceCodeFlow(): Promise<DeviceCodeInfo> {
  if (!CLIENT_ID) throw new Error("XBOX_CLIENT_ID env var not set");

  if (dcState?.status === "pending" && Date.now() < dcState.expiresAt) return dcState;

  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: SIGNIN_SCOPE });
  const res  = await fetch(
    xboxUrl(DEVICECODE_URL),
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal:  AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device code request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    device_code: string; user_code: string; verification_uri: string;
    expires_in: number; interval: number;
  };

  dcDeviceCode = data.device_code;
  dcInterval   = data.interval * 1_000;
  dcState = {
    userCode:        data.user_code,
    verificationUri: data.verification_uri,
    expiresAt:       Date.now() + data.expires_in * 1_000,
    status:          "pending",
  };

  logger.info({ verificationUri: dcState.verificationUri }, "Device code flow started");
  logAudit("ACCOUNT_AUTH_STARTED", {});
  pollLoop().catch((err) => logger.error({ err }, "Poll loop error"));
  return dcState;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getDeviceCodeState(): DeviceCodeInfo | null { return dcState; }

export function getAccountInfoList(): AccountInfo[] {
  return [...accounts.values()].map((a) => ({
    id:          a.id,
    xuid:        a.xuid,
    gamertag:    a.gamertag,
    maskedEmail: a.maskedEmail,
    addedAt:     a.addedAt,
    isActive:    a.id === activeAccountId,
    xstsReady:   xstsValid(a),
    readiness:   a.readiness,
  }));
}

export function removeAccount(id: string): boolean {
  if (!accounts.has(id)) return false;
  accounts.delete(id);
  if (activeAccountId === id) {
    activeAccountId = accounts.keys().next().value ?? null;
  }
  persistAccounts();
  logger.info({ accountId: id }, "Xbox account removed");
  logAudit("ACCOUNT_DISCONNECTED", { accountId: id });
  return true;
}

export function setActiveAccount(id: string): boolean {
  if (!accounts.has(id)) return false;
  activeAccountId = id;
  persistAccounts();
  logger.info({ accountId: id }, "Active Xbox account changed");
  return true;
}

export function getActiveAccountId(): string | null { return activeAccountId; }

/**
 * Sign out all accounts — clears in-memory state and overwrites
 * .xbox-auth.json with an empty v2 record so they don't reload on restart.
 */
export function logoutAllAccounts(): void {
  const ids = [...accounts.keys()];
  accounts.clear();
  activeAccountId = null;
  try {
    const empty = { version: 2, accounts: [], activeAccountId: null };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(empty, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch { /* non-critical */ }
  logger.info("All Xbox accounts signed out");
  for (const id of ids) logAudit("ACCOUNT_DISCONNECTED", { accountId: id });
}

/** Auth header for availability checks — uses the active account (or first available). */
export async function getAuthHeader(): Promise<string | null> {
  const id = activeAccountId ?? accounts.keys().next().value;
  if (!id) return null;
  const xsts = await fetchXstsForAccount(id);
  if (!xsts) return null;
  return `XBL3.0 x=${xsts.uhs};${xsts.token}`;
}

/** Everything a claim needs, for the given account (default: the active one) — or the exact reason it isn't available. */
export type ClaimContext =
  | { ok: true; accountId: string; authHeader: string; xuid: string; gamertag: string | null }
  | { ok: false; stage: AuthStage; reason: string; code: string | null };

export async function getClaimContext(accountId?: string): Promise<ClaimContext> {
  const id = accountId ?? activeAccountId;
  if (!id) {
    return { ok: false, stage: "none", reason: "No Xbox account connected. Connect Xbox first.", code: null };
  }
  const account = accounts.get(id);
  if (!account) return { ok: false, stage: "none", reason: "No Xbox account connected. Connect Xbox first.", code: null };
  const xsts = await fetchXstsForAccount(id);
  if (!xsts) {
    return {
      ok: false,
      stage: account.readiness.stage,
      reason: account.readiness.reason ?? "Xbox authentication failed.",
      code: account.readiness.code,
    };
  }
  if (!account.xuid) {
    return { ok: false, stage: "xuid", reason: "Xbox did not return an XUID for this account, so it cannot claim gamertags.", code: null };
  }
  return {
    ok: true,
    accountId: account.id,
    authHeader: `XBL3.0 x=${xsts.uhs};${xsts.token}`,
    xuid: account.xuid,
    gamertag: account.gamertag,
  };
}

/**
 * Re-issues the given account's XSTS token (default: the active one; reuses
 * the cached Xbox Live user token when possible) and returns the gamertag
 * Xbox now reports for it. Used to independently confirm a claim; also used
 * by "Verify" in the UI.
 */
export async function refreshActiveIdentity(accountId?: string): Promise<{ ok: boolean; gamertag: string | null; xuid: string | null }> {
  const id = accountId ?? activeAccountId;
  if (!id) return { ok: false, gamertag: null, xuid: null };
  const account = accounts.get(id);
  if (!account) return { ok: false, gamertag: null, xuid: null };
  const r = await fetchXstsForAccount(id, true);
  return { ok: r !== null, gamertag: account.gamertag, xuid: account.xuid };
}

/** Active-account readiness plus display-safe identity. */
export interface ActiveAccountStatus {
  connected:   boolean;
  ready:       boolean;
  stage:       AuthStage;
  reason:      string | null;
  code:        string | null;
  checkedAt:   number | null;
  maskedEmail: string | null;
  gamertag:    string | null;
  maskedXuid:  string | null;
}

export function getActiveAccountStatus(): ActiveAccountStatus {
  const account = activeAccountId ? accounts.get(activeAccountId) : undefined;
  if (!account) {
    return {
      connected: false, ready: false, stage: "none", reason: "No Xbox account connected.", code: null,
      checkedAt: null, maskedEmail: null, gamertag: null, maskedXuid: null,
    };
  }
  // A cached token that has since expired is not "ready" until re-verified.
  const ready = account.readiness.ready && xstsValid(account) && !!account.xuid;
  return {
    connected:   !account.revoked,
    ready,
    stage:       ready ? "ready" : account.readiness.stage,
    reason:      ready ? null : (account.readiness.reason ?? "Not verified yet."),
    code:        ready ? null : account.readiness.code,
    checkedAt:   account.readiness.checkedAt,
    maskedEmail: account.maskedEmail,
    gamertag:    account.gamertag,
    maskedXuid:  maskXuid(account.xuid),
  };
}

/** Runs the full chain now (using cached tokens when valid) and returns the result. */
export async function verifyActiveAccount(): Promise<ActiveAccountStatus> {
  if (activeAccountId) await fetchXstsForAccount(activeAccountId);
  return getActiveAccountStatus();
}

/** XUID of the active account (used for claim URLs). */
export function getXuid(): string | null {
  if (!activeAccountId) return null;
  return accounts.get(activeAccountId)?.xuid ?? null;
}

export function isAuthenticated(): boolean {
  for (const a of accounts.values()) if (!a.revoked) return true;
  return false;
}

export function isXstsReady(): boolean {
  if (!activeAccountId) return false;
  const a = accounts.get(activeAccountId);
  return !!a && xstsValid(a);
}

export function preWarmXboxAuth(): void {
  if (accounts.size === 0) return;
  logger.info({ count: accounts.size }, "Pre-warming XSTS tokens for all accounts...");
  for (const id of accounts.keys()) {
    fetchXstsForAccount(id)
      .then((r) => {
        if (r) logger.info({ accountId: id }, "✅ XSTS pre-warmed");
        else   logger.warn({ accountId: id }, "Pre-warm failed — token may be expired");
      })
      .catch((err) => logger.warn({ accountId: id, err }, "Pre-warm error"));
  }
}

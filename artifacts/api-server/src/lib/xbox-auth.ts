/**
 * Xbox Live authentication — multi-account via OAuth2 device code flow.
 *
 * Multiple accounts can be signed in simultaneously. One account is designated
 * "active" and used for gamertag claim/change operations.
 * Any authenticated account (defaulting to active) is used for availability checks.
 *
 * Storage: .xbox-auth.json (v2 format)
 *   { version: 2, accounts: StoredAccount[], activeAccountId: string | null }
 * Legacy v1 format ({ refreshToken }) is auto-migrated on first load.
 */

import { logger } from "./logger";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// App registration "GT hinter". The client ID is a public identifier (not a
// secret) and is kept on the server. Override with XBOX_CLIENT_ID.
const DEFAULT_CLIENT_ID = "94028da3-aa0c-4c46-b5ec-ac40baaba225";
const CLIENT_ID = process.env["XBOX_CLIENT_ID"]?.trim() || DEFAULT_CLIENT_ID;
// "consumers" is required for personal Microsoft accounts (Xbox Live). Set
// XBOX_TENANT_ID only if the app registration is restricted to one tenant.
const TENANT    = process.env["XBOX_TENANT_ID"]?.trim() || "consumers";
const SCOPE     = "XboxLive.signin offline_access";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AccountInfo {
  id:        string;
  xuid:      string | null;
  gamertag:  string | null;
  addedAt:   number;  // epoch ms
  isActive:  boolean;
  xstsReady: boolean;
}

interface AccountState {
  id:              string;
  msRefreshToken:  string;
  xuid:            string | null;
  gamertag:        string | null;
  addedAt:         number;
  // General XSTS (http://xboxlive.com) — for availability checks
  xstsToken:       string | null;
  xstsExpiry:      number;
  uhs:             string | null;
  // Claim XSTS (http://accounts.xboxlive.com) — for gamertag name changes
  xstsClaimToken:  string | null;
  xstsClaimExpiry: number;
  uhsClaim:        string | null;
}

// ─── In-memory store ──────────────────────────────────────────────────────────

const accounts       = new Map<string, AccountState>();
let activeAccountId: string | null = null;

// Per-account in-flight promise — prevents concurrent MS token refreshes.
// Microsoft refresh tokens are single-use; a second concurrent use invalidates the first.
const inFlight = new Map<string, Promise<{ token: string; uhs: string } | null>>();

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
  addedAt:        number;
  msRefreshToken: string;
}

function persistAccounts(): void {
  try {
    const data: StoredV2 = {
      version: 2,
      activeAccountId,
      accounts: [...accounts.values()].map((a) => ({
        id:             a.id,
        xuid:           a.xuid,
        gamertag:       a.gamertag,
        addedAt:        a.addedAt,
        msRefreshToken: a.msRefreshToken,
      })),
    };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch { /* non-critical */ }
}

function makeAccount(
  id: string,
  msRefreshToken: string,
  addedAt: number,
  xuid:     string | null = null,
  gamertag: string | null = null,
): AccountState {
  return {
    id, msRefreshToken, addedAt, xuid, gamertag,
    xstsToken: null, xstsExpiry: 0, uhs: null,
    xstsClaimToken: null, xstsClaimExpiry: 0, uhsClaim: null,
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
        accounts.set(stored.id, makeAccount(stored.id, stored.msRefreshToken, stored.addedAt, stored.xuid, stored.gamertag));
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

// ─── Microsoft token refresh ──────────────────────────────────────────────────

async function refreshMsToken(account: AccountState): Promise<string | null> {
  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    grant_type:    "refresh_token",
    refresh_token: account.msRefreshToken,
    scope:         SCOPE,
  });

  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
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
          logger.warn({ accountId: account.id, error: errCode }, "MS refresh token revoked — removing account");
          accounts.delete(account.id);
          if (activeAccountId === account.id) {
            activeAccountId = accounts.keys().next().value ?? null;
          }
          persistAccounts();
        } else {
          logger.warn({ accountId: account.id, status: res.status, error: errCode }, "MS token refresh rejected — retaining for retry");
        }
      } else {
        logger.warn({ accountId: account.id, status: res.status }, "MS token refresh server error (transient) — retaining");
      }
      return null;
    }

    const data = (await res.json()) as { access_token: string; refresh_token: string };
    account.msRefreshToken = data.refresh_token;
    persistAccounts();
    logger.info({ accountId: account.id }, "MS refresh token rotated and persisted");
    return data.access_token;
  } catch (err) {
    logger.warn({ accountId: account.id, err }, "MS token refresh network error — retaining");
    return null;
  }
}

// ─── XSTS fetch ───────────────────────────────────────────────────────────────

async function _doFetchXsts(account: AccountState): Promise<{ token: string; uhs: string } | null> {
  const msToken = await refreshMsToken(account);
  if (!msToken) return null;

  try {
    // Exchange MS token → XBL token
    const xblRes = await fetch("https://user.auth.xboxlive.com/user/authenticate", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        Properties:   { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${msToken}` },
        RelyingParty: "http://auth.xboxlive.com",
        TokenType:    "JWT",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!xblRes.ok) {
      logger.warn({ accountId: account.id, status: xblRes.status }, "XBL auth failed");
      return null;
    }
    const xblData  = (await xblRes.json()) as { Token: string; DisplayClaims: { xui: [{ uhs: string }] } };
    const xblToken = xblData.Token;
    const uhs      = xblData.DisplayClaims.xui[0]!.uhs;

    // Exchange XBL token → two XSTS tokens in parallel:
    //   1. http://xboxlive.com          — general API calls (checking)
    //   2. http://accounts.xboxlive.com — gamertag claim/change endpoint
    const xstsBody = (rp: string) => JSON.stringify({
      Properties:   { SandboxId: "RETAIL", UserTokens: [xblToken] },
      RelyingParty: rp,
      TokenType:    "JWT",
    });

    const [xstsRes, xstsClaimRes] = await Promise.all([
      fetch("https://xsts.auth.xboxlive.com/xsts/authorize", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: xstsBody("http://xboxlive.com"), signal: AbortSignal.timeout(10_000),
      }),
      fetch("https://xsts.auth.xboxlive.com/xsts/authorize", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: xstsBody("http://accounts.xboxlive.com"), signal: AbortSignal.timeout(10_000),
      }),
    ]);

    if (!xstsRes.ok) {
      logger.warn({ accountId: account.id, status: xstsRes.status }, "XSTS auth failed (xboxlive.com)");
      return null;
    }
    const xstsData = (await xstsRes.json()) as {
      Token: string; NotAfter: string;
      DisplayClaims?: { xui?: Array<{ uhs?: string; xid?: string }> };
    };
    account.xstsToken  = xstsData.Token;
    account.uhs        = uhs;
    account.xstsExpiry = new Date(xstsData.NotAfter).getTime();

    const xuiClaims = xstsData.DisplayClaims?.xui;
    if (xuiClaims?.[0]?.xid && !account.xuid) {
      account.xuid = xuiClaims[0].xid;
      persistAccounts();
    }

    // Cache claim XSTS (best-effort — checking still works without it)
    if (xstsClaimRes.ok) {
      try {
        const claimData = (await xstsClaimRes.json()) as {
          Token: string; NotAfter: string;
          DisplayClaims?: { xui?: Array<{ uhs?: string }> };
        };
        account.xstsClaimToken  = claimData.Token;
        account.xstsClaimExpiry = new Date(claimData.NotAfter).getTime();
        account.uhsClaim        = claimData.DisplayClaims?.xui?.[0]?.uhs ?? uhs;
        logger.info({ accountId: account.id, expiresAt: claimData.NotAfter }, "✅ Claim XSTS token obtained (accounts.xboxlive.com)");
      } catch {
        logger.warn({ accountId: account.id }, "Failed to parse claim XSTS response");
      }
    } else {
      const body = await xstsClaimRes.text().catch(() => "");
      logger.warn({ accountId: account.id, status: xstsClaimRes.status, body }, "Claim XSTS failed");
    }

    logger.info({ accountId: account.id, expiresAt: xstsData.NotAfter }, "✅ XSTS token obtained — ready for Xbox API calls");
    return { token: account.xstsToken, uhs };
  } catch (err) {
    logger.warn({ accountId: account.id, err }, "XSTS fetch error");
    return null;
  }
}

async function fetchXstsForAccount(id: string): Promise<{ token: string; uhs: string } | null> {
  const account = accounts.get(id);
  if (!account) return null;

  // Return cached if still valid (5-min buffer)
  if (account.xstsToken && account.uhs && Date.now() < account.xstsExpiry - 5 * 60_000) {
    return { token: account.xstsToken, uhs: account.uhs };
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
    const needsRefresh =
      account.xstsExpiry      === 0 || Date.now() > account.xstsExpiry      - 10 * 60_000 ||
      account.xstsClaimExpiry === 0 || Date.now() > account.xstsClaimExpiry - 10 * 60_000;
    if (needsRefresh && !inFlight.has(id)) {
      fetchXstsForAccount(id).catch((err) => logger.warn({ accountId: id, err }, "Proactive XSTS refresh error"));
    }
  }
}, 60_000);

// ─── Device code flow ─────────────────────────────────────────────────────────

export interface DeviceCodeInfo {
  userCode:        string;
  verificationUri: string;
  expiresAt:       number;
  status:          "pending" | "authorized" | "expired" | "error";
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
        `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal:  AbortSignal.timeout(10_000),
        },
      );
      const data = (await res.json()) as { error?: string; access_token?: string; refresh_token?: string };

      if (data.error === "authorization_pending" || data.error === "slow_down") continue;
      if (data.error) {
        logger.warn({ error: data.error }, "Device code flow error");
        if (dcState) dcState.status = "error";
        return;
      }

      if (data.access_token && data.refresh_token) {
        const id      = crypto.randomUUID();
        const account = makeAccount(id, data.refresh_token, Date.now());
        accounts.set(id, account);

        // First account (or only one) becomes active automatically
        if (!activeAccountId) activeAccountId = id;
        persistAccounts();

        if (dcState) dcState.status = "authorized";
        logger.info({ accountId: id }, "✅ New Xbox account added");

        // Pre-warm XSTS in background
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

  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE });
  const res  = await fetch(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal:  AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device code request failed (${res.status}): ${text}`);
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

  logger.info({ verificationUri: dcState.verificationUri, userCode: dcState.userCode }, "Device code flow started");
  pollLoop().catch((err) => logger.error({ err }, "Poll loop error"));
  return dcState;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getDeviceCodeState(): DeviceCodeInfo | null { return dcState; }

export function getAccountInfoList(): AccountInfo[] {
  return [...accounts.values()].map((a) => ({
    id:        a.id,
    xuid:      a.xuid,
    gamertag:  a.gamertag,
    addedAt:   a.addedAt,
    isActive:  a.id === activeAccountId,
    xstsReady: !!(a.xstsToken && a.uhs && Date.now() < a.xstsExpiry - 5 * 60_000),
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
  accounts.clear();
  activeAccountId = null;
  try {
    const empty = { version: 2, accounts: [], activeAccountId: null };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(empty, null, 2), "utf8");
  } catch { /* non-critical */ }
  logger.info("All Xbox accounts signed out");
}

/** Auth header for availability checks — uses the active account (or first available). */
export async function getAuthHeader(): Promise<string | null> {
  const id = activeAccountId ?? accounts.keys().next().value;
  if (!id) return null;
  const xsts = await fetchXstsForAccount(id);
  if (!xsts) return null;
  return `XBL3.0 x=${xsts.uhs};${xsts.token}`;
}

/**
 * Auth header scoped to http://accounts.xboxlive.com for claim/change operations.
 * Strictly uses the active account.
 */
export async function getClaimAuthHeader(): Promise<string | null> {
  if (!activeAccountId) return null;
  await fetchXstsForAccount(activeAccountId);
  const account = accounts.get(activeAccountId);
  if (!account) return null;

  if (account.xstsClaimToken && account.uhsClaim && Date.now() < account.xstsClaimExpiry - 5 * 60_000) {
    return `XBL3.0 x=${account.uhsClaim};${account.xstsClaimToken}`;
  }

  logger.warn({ accountId: activeAccountId }, "Claim XSTS unavailable — falling back to general token");
  return getAuthHeader();
}

/** XUID of the active account (used for claim URLs). */
export function getXuid(): string | null {
  if (!activeAccountId) return null;
  return accounts.get(activeAccountId)?.xuid ?? null;
}

export function isAuthenticated(): boolean { return accounts.size > 0; }

export function isXstsReady(): boolean {
  if (!activeAccountId) return false;
  const a = accounts.get(activeAccountId);
  return !!(a?.xstsToken && a?.uhs && Date.now() < a.xstsExpiry - 5 * 60_000);
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

import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Readiness of the account that performs claims, as verified by the server
 * (Microsoft → Xbox Live → XSTS → XUID). Display-safe: masked email and
 * XUID only; tokens never leave the server.
 */
export interface XboxAccountStatus {
  connected:   boolean;
  ready:       boolean;
  stage:       "none" | "microsoft" | "xbox_live" | "xsts" | "xuid" | "ready";
  reason:      string | null;
  code:        string | null;
  checkedAt:   number | null;
  maskedEmail: string | null;
  gamertag:    string | null;
  maskedXuid:  string | null;
}

export interface AuthStatus {
  authenticated: boolean;
  xstsReady:     boolean;
  account?:      XboxAccountStatus;
  deviceCode: {
    userCode:        string;
    verificationUri: string;
    status:          "pending" | "authorized" | "expired" | "error";
    expiresAt:       number;
    error?:          string;
  } | null;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function useXboxAuth() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const fastPollRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const slowPollRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/auth/xbox/status`);
      if (res.ok) setStatus(await res.json() as AuthStatus);
    } catch { /* ignore */ }
  }, []);

  // Fetch once on mount
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Slow background poll every 15 s — keeps auth state in sync after server
  // restarts, token rotations, or external re-authentication.
  useEffect(() => {
    slowPollRef.current = setInterval(fetchStatus, 15_000);
    return () => {
      if (slowPollRef.current) clearInterval(slowPollRef.current);
    };
  }, [fetchStatus]);

  // Fast poll (3 s) while a device code flow is pending, and while a fresh
  // sign-in is still resolving Xbox Live/XSTS, so readiness shows promptly.
  useEffect(() => {
    const isPending = status?.deviceCode?.status === "pending" ||
      (status?.authenticated === true && status.account?.checkedAt === null);
    if (isPending && !fastPollRef.current) {
      fastPollRef.current = setInterval(fetchStatus, 3_000);
    } else if (!isPending && fastPollRef.current) {
      clearInterval(fastPollRef.current);
      fastPollRef.current = null;
    }
    return () => {
      if (fastPollRef.current) { clearInterval(fastPollRef.current); fastPollRef.current = null; }
    };
  }, [status, fetchStatus]);

  const startAuth = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/xbox/start`, { method: "POST" });
      if (res.ok) {
        const data = await res.json() as AuthStatus["deviceCode"];
        setStatus((prev) => ({
          authenticated: prev?.authenticated ?? false,
          xstsReady:     prev?.xstsReady     ?? false,
          deviceCode: data,
        }));
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  /** Asks the server to run the full auth chain now. */
  const verify = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/xbox/verify`, { method: "POST" });
      if (res.ok) {
        const d = await res.json() as Pick<AuthStatus, "authenticated" | "xstsReady" | "account">;
        setStatus((prev) => ({ deviceCode: prev?.deviceCode ?? null, ...d }));
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await fetch(`${BASE}/api/auth/xbox/logout`, { method: "POST" });
      await fetchStatus();
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  return { status, loading, startAuth, logout, verify, refetch: fetchStatus };
}

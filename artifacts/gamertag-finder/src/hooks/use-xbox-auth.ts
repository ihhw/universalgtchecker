import { useState, useEffect, useCallback, useRef } from "react";

export interface AuthStatus {
  authenticated: boolean;
  xstsReady:     boolean;
  deviceCode: {
    userCode:        string;
    verificationUri: string;
    status:          "pending" | "authorized" | "expired" | "error";
    expiresAt:       number;
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

  // Fast poll (3 s) while a device code flow is pending so we catch the
  // moment the user signs in without delay.
  useEffect(() => {
    const isPending = status?.deviceCode?.status === "pending";
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

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await fetch(`${BASE}/api/auth/xbox/logout`, { method: "POST" });
      await fetchStatus();
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  return { status, loading, startAuth, logout, refetch: fetchStatus };
}

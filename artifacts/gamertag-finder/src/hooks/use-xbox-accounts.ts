import { useCallback, useEffect, useState } from "react";

export interface XboxAccountInfo {
  id: string;
  xuid: string | null;
  gamertag: string | null;
  maskedEmail: string | null;
  addedAt: number;
  isActive: boolean;
  xstsReady: boolean;
  readiness: {
    ready: boolean;
    stage: "none" | "microsoft" | "xbox_live" | "xsts" | "xuid" | "ready";
    reason: string | null;
    code: string | null;
    checkedAt: number | null;
  };
  rateLimitedUntil: number | null;
  rateLimitReason: string | null;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Every signed-in Xbox account (Account Manager) — display-safe, never a token. */
export function useXboxAccounts() {
  const [accounts, setAccounts] = useState<XboxAccountInfo[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/auth/xbox/accounts`);
      if (res.ok) setAccounts(((await res.json()) as { accounts: XboxAccountInfo[] }).accounts);
    } catch { /* ignore; next poll retries */ }
  }, []);

  useEffect(() => {
    void refetch();
    const t = setInterval(refetch, 10_000);
    return () => clearInterval(t);
  }, [refetch]);

  const activate = useCallback(async (id: string): Promise<boolean> => {
    setBusyId(id);
    try {
      const res = await fetch(`${BASE}/api/auth/xbox/accounts/${encodeURIComponent(id)}/activate`, { method: "POST" });
      await refetch();
      return res.ok;
    } catch {
      return false;
    } finally {
      setBusyId(null);
    }
  }, [refetch]);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    setBusyId(id);
    try {
      const res = await fetch(`${BASE}/api/auth/xbox/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refetch();
      return res.ok;
    } catch {
      return false;
    } finally {
      setBusyId(null);
    }
  }, [refetch]);

  return { accounts, busyId, refetch, activate, remove };
}

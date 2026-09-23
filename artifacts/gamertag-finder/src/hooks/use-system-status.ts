import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export type ServiceState = "online" | "degraded" | "offline" | "unknown";
export interface ServiceStatus { id: string; label: string; state: ServiceState; detail: string }

const POLL_MS = 5_000;

const UNREACHABLE: ServiceStatus[] = [
  { id: "api", label: "API", state: "offline", detail: "Unreachable from this browser" },
  ...["Xbox API", "Checker engine", "Realtime", "Discord bot"].map((label) => ({
    id: label, label, state: "unknown" as ServiceState, detail: "Can't be verified without the API",
  })),
];

/** Polls GET /api/status. Shared by the System Status page and the Command Center. */
export function useSystemStatus() {
  const [services, setServices] = useState<ServiceStatus[] | null>(null);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const res = await fetch(api("/status"), { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { checkedAt: number; services: ServiceStatus[] };
        if (!disposed) { setServices(data.services); setCheckedAt(data.checkedAt); setApiReachable(true); }
      } catch {
        if (!disposed) setApiReachable(false);
      } finally {
        if (!disposed) timer = setTimeout(tick, POLL_MS);
      }
    };
    void tick();

    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, []);

  const rows = apiReachable === false ? UNREACHABLE : (services ?? []);
  const loading = services === null && apiReachable === null;
  return { rows, apiReachable, checkedAt, loading };
}

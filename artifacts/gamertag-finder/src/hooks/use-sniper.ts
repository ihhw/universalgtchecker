import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { XboxAccountStatus } from "@/hooks/use-xbox-auth";

export type SniperState = "idle" | "watching" | "claiming" | "claimed" | "stopped" | "error";
export type SniperAvailability =
  | "unknown" | "taken" | "available" | "invalid" | "rate_limited" | "network_error" | "auth_error";
export type SniperClaim =
  | "waiting" | "disabled" | "claiming" | "claimed" | "claim_failed"
  | "auth_error" | "rate_limited" | "network_error" | "unknown";

export interface SniperConfig {
  target: string;
  intervalMs: number;
  autoClaim: boolean;
  notifications: boolean;
  doubleCheck: boolean;
}

export interface SniperEvent {
  seq: number;
  ts: number;
  level: "info" | "check" | "taken" | "available" | "claim" | "success" | "warn" | "error";
  message: string;
}

export interface SniperClaimRecord {
  state: string;
  reason: string | null;
  httpStatus: number | null;
  step: string | null;
  confirmedBy: "change_response" | "xsts_identity" | null;
  xboxResponse: string | null;
  latency: { authMs: number | null; reserveMs: number | null; changeMs: number | null; confirmMs: number | null; totalMs: number | null };
}

export interface SniperSnapshot {
  runId: string | null;
  state: SniperState;
  config: SniperConfig;
  availability: SniperAvailability;
  availabilityDetail: string | null;
  claim: SniperClaim;
  claimReason: string | null;
  checks: number;
  claimAttempts: number;
  lastCheckAt: number | null;
  lastClaimAt: number | null;
  nextCheckAt: number | null;
  backoffUntil: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  stopReason: string | null;
  latency: {
    availabilityMs: number | null;
    avgAvailabilityMs: number | null;
    claimMs: number | null;
    reactionMs: number | null;
    totalMs: number | null;
  };
  lastClaim: SniperClaimRecord | null;
  account: XboxAccountStatus;
  eventSeq: number;
  events: SniperEvent[];
  limits?: { minIntervalMs: number; maxIntervalMs: number };
}

const MAX_EVENTS = 300;
const POLL_MS = 1_500;

/**
 * Sniper state from the backend. The snapshot endpoint is authoritative and
 * is polled continuously; SSE only makes updates arrive sooner. A refresh,
 * a dropped stream or a closed tab never affects the run itself.
 */
export function useSniper() {
  const [snapshot, setSnapshot] = useState<SniperSnapshot | null>(null);
  const [events, setEvents] = useState<SniperEvent[]>([]);
  const [streamConnected, setStreamConnected] = useState(false);
  const [reachable, setReachable] = useState(true);
  const lastSeq = useRef(0);
  const pollNow = useRef<() => void>(() => {});

  const mergeEvents = useCallback((incoming: SniperEvent[], replace = false) => {
    if (!replace && incoming.length === 0) return;
    setEvents((prev) => {
      const base = replace ? [] : prev;
      const known = new Set(base.map((e) => e.seq));
      const add = incoming.filter((e) => !known.has(e.seq));
      if (!replace && add.length === 0) return prev;
      const out = [...base, ...add].sort((a, b) => a.seq - b.seq);
      return out.length > MAX_EVENTS ? out.slice(out.length - MAX_EVENTS) : out;
    });
    for (const e of incoming) if (e.seq > lastSeq.current) lastSeq.current = e.seq;
  }, []);

  const applySnapshot = useCallback((snap: SniperSnapshot, full: boolean) => {
    // The server's event sequence restarted (e.g. state file reset): resync.
    const reset = snap.eventSeq < lastSeq.current;
    if (reset) lastSeq.current = 0;
    setSnapshot(snap);
    mergeEvents(snap.events, full || reset);
  }, [mergeEvents]);

  // Polling: the source of truth.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const tick = async () => {
      if (disposed) return;
      try {
        const url = first ? api("/xbox/sniper") : api(`/xbox/sniper?after=${lastSeq.current}`);
        const res = await fetch(url);
        if (res.ok) {
          applySnapshot((await res.json()) as SniperSnapshot, first);
          first = false;
          setReachable(true);
        } else {
          setReachable(false);
        }
      } catch {
        setReachable(false);
      }
      if (!disposed) timer = setTimeout(tick, document.hidden ? POLL_MS * 3 : POLL_MS);
    };
    pollNow.current = () => { if (timer) clearTimeout(timer); void tick(); };
    void tick();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [applySnapshot]);

  // SSE: realtime enhancement only.
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(api("/xbox/sniper/stream"));
      es.onopen = () => setStreamConnected(true);
      es.onerror = () => setStreamConnected(false); // the browser reconnects by itself
      es.addEventListener("snapshot", (m) => {
        try { applySnapshot(JSON.parse((m as MessageEvent<string>).data) as SniperSnapshot, false); } catch { /* bad frame */ }
      });
      es.addEventListener("event", (m) => {
        try { mergeEvents([JSON.parse((m as MessageEvent<string>).data) as SniperEvent]); } catch { /* bad frame */ }
      });
    } catch {
      setStreamConnected(false);
    }
    return () => { es?.close(); };
  }, [applySnapshot, mergeEvents]);

  const start = useCallback(async (config: SniperConfig): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(api("/xbox/sniper/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      pollNow.current();
      return res.status === 201 ? { ok: true } : { ok: false, error: data.error ?? `HTTP ${res.status}` };
    } catch {
      return { ok: false, error: "Could not reach the server." };
    }
  }, []);

  const stop = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(api("/xbox/sniper/stop"), { method: "POST" });
      pollNow.current();
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Pick<SniperConfig, "autoClaim" | "notifications">>) => {
    try {
      await fetch(api("/xbox/sniper/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } finally {
      pollNow.current();
    }
  }, []);

  return { snapshot, events, streamConnected, reachable, start, stop, updateSettings };
}

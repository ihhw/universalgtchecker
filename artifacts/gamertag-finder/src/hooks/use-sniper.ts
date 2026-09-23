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

/** One watched target's full state, as the server reports it. */
export interface SniperSnapshot {
  id: string;
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
  createdAt: number;
}

export interface SniperLimits { minIntervalMs: number; maxIntervalMs: number; maxTargets: number }

const MAX_EVENTS = 300;
const POLL_MS = 1_500;
const DEFAULT_LIMITS: SniperLimits = { minIntervalMs: 500, maxIntervalMs: 60_000, maxTargets: 5 };

/**
 * Multi-target sniper state from the backend. GET /xbox/sniper (the list) is
 * authoritative and is polled continuously; SSE only makes updates arrive
 * sooner. A refresh, a dropped stream or a closed tab never affects any
 * running target.
 */
export function useSniperTargets() {
  const [targets, setTargets] = useState<SniperSnapshot[]>([]);
  const [eventsById, setEventsById] = useState<Map<string, SniperEvent[]>>(new Map());
  const [limits, setLimits] = useState<SniperLimits>(DEFAULT_LIMITS);
  const [streamConnected, setStreamConnected] = useState(false);
  const [reachable, setReachable] = useState(true);
  const lastSeqById = useRef(new Map<string, number>());
  const pollNow = useRef<() => void>(() => {});

  const mergeEvents = useCallback((id: string, incoming: SniperEvent[], replace = false) => {
    if (!replace && incoming.length === 0) return;
    setEventsById((prev) => {
      const base = replace ? [] : (prev.get(id) ?? []);
      const known = new Set(base.map((e) => e.seq));
      const add = incoming.filter((e) => !known.has(e.seq));
      if (!replace && add.length === 0) return prev;
      const merged = [...base, ...add].sort((a, b) => a.seq - b.seq);
      const bounded = merged.length > MAX_EVENTS ? merged.slice(merged.length - MAX_EVENTS) : merged;
      const next = new Map(prev);
      next.set(id, bounded);
      return next;
    });
    let max = lastSeqById.current.get(id) ?? 0;
    for (const e of incoming) if (e.seq > max) max = e.seq;
    lastSeqById.current.set(id, max);
  }, []);

  const applySnapshots = useCallback((list: SniperSnapshot[], full: boolean) => {
    setTargets(list);
    const liveIds = new Set(list.map((t) => t.id));
    setEventsById((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!liveIds.has(id)) { next.delete(id); lastSeqById.current.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
    for (const t of list) {
      // The server's event sequence restarted for this target (e.g. state file reset): resync.
      const reset = t.eventSeq < (lastSeqById.current.get(t.id) ?? 0);
      if (reset) lastSeqById.current.set(t.id, 0);
      mergeEvents(t.id, t.events, full || reset);
    }
  }, [mergeEvents]);

  // Polling: the source of truth.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const tick = async () => {
      if (disposed) return;
      try {
        const res = await fetch(api("/xbox/sniper"));
        if (res.ok) {
          const data = (await res.json()) as { targets: SniperSnapshot[]; limits: SniperLimits };
          applySnapshots(data.targets, first);
          setLimits(data.limits);
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
  }, [applySnapshots]);

  // SSE: realtime enhancement only.
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(api("/xbox/sniper/stream"));
      es.onopen = () => setStreamConnected(true);
      es.onerror = () => setStreamConnected(false); // the browser reconnects by itself
      es.addEventListener("snapshot", (m) => {
        try {
          const d = JSON.parse((m as MessageEvent<string>).data) as { targets: SniperSnapshot[] };
          applySnapshots(d.targets, false);
        } catch { /* bad frame */ }
      });
      es.addEventListener("event", (m) => {
        try {
          const d = JSON.parse((m as MessageEvent<string>).data) as { id: string; event: SniperEvent };
          mergeEvents(d.id, [d.event]);
        } catch { /* bad frame */ }
      });
    } catch {
      setStreamConnected(false);
    }
    return () => { es?.close(); };
  }, [applySnapshots, mergeEvents]);

  const startTarget = useCallback(async (config: SniperConfig): Promise<{ ok: boolean; id?: string; error?: string }> => {
    try {
      const res = await fetch(api("/xbox/sniper/targets"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      pollNow.current();
      return res.status === 201 ? { ok: true, id: data.id } : { ok: false, error: data.error ?? `HTTP ${res.status}` };
    } catch {
      return { ok: false, error: "Could not reach the server." };
    }
  }, []);

  const stopTarget = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(api(`/xbox/sniper/targets/${encodeURIComponent(id)}/stop`), { method: "POST" });
      pollNow.current();
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const removeTarget = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(api(`/xbox/sniper/targets/${encodeURIComponent(id)}`), { method: "DELETE" });
      pollNow.current();
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const updateTargetSettings = useCallback(async (id: string, patch: Partial<Pick<SniperConfig, "autoClaim" | "notifications">>) => {
    try {
      await fetch(api(`/xbox/sniper/targets/${encodeURIComponent(id)}/settings`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } finally {
      pollNow.current();
    }
  }, []);

  return { targets, eventsById, limits, streamConnected, reachable, startTarget, stopTarget, removeTarget, updateTargetSettings };
}

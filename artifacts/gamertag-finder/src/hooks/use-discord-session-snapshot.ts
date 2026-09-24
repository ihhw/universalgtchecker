import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export interface DiscordSessionSnapshot {
  state: "running" | "completed" | "cancelled";
  attempts: number;
  found: number;
  taken: number;
  unknown: number;
  paused: boolean;
  cps: number;
}

const POLL_MS = 1_500;

/**
 * Polls the backend Discord session snapshot, which is the source of truth
 * for progress, pause/resume and cancellation. It keeps working when SSE drops.
 */
export function useDiscordSessionSnapshot(sessionId: string | null, onMissing: () => void) {
  const [snapshot, setSnapshot] = useState<DiscordSessionSnapshot | null>(null);
  const onMissingRef = useRef(onMissing);
  onMissingRef.current = onMissing;
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!sessionId) {
      setSnapshot(null);
      refreshRef.current = () => {};
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const tick = async () => {
      if (disposed) return;
      let keepGoing = true;
      try {
        const res = await fetch(api(`/discord/sessions/${encodeURIComponent(sessionId)}`), {
          signal: controller.signal,
        });
        if (res.status === 404) {
          keepGoing = false;
          if (!disposed) onMissingRef.current();
        } else if (res.ok) {
          const d = (await res.json()) as Partial<DiscordSessionSnapshot>;
          if (!disposed) {
            setSnapshot({
              state: d.state ?? "running",
              attempts: d.attempts ?? 0,
              found: d.found ?? 0,
              taken: d.taken ?? 0,
              unknown: d.unknown ?? 0,
              paused: d.paused === true,
              cps: d.cps ?? 0,
            });
            if (d.state && d.state !== "running") keepGoing = false;
          }
        }
      } catch {
        /* transient network error: retry */
      }
      if (keepGoing && !disposed) timer = setTimeout(tick, document.hidden ? POLL_MS * 3 : POLL_MS);
    };

    refreshRef.current = () => {
      if (timer) clearTimeout(timer);
      void tick();
    };
    void tick();

    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { snapshot, refresh };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ActivityEvent } from "@/lib/api";

const MAX_FEED = 300;      // rows kept in browser state
const MAX_HITS = 200;      // hits kept in browser state
const MAX_PENDING = 600;   // safety cap on the un-flushed buffer
const FLUSH_MS = 250;      // batch SSE bursts so React renders at most ~4x/sec
const POLL_MS = 2_000;

/**
 * Real backend events, delivered over SSE with a polling fallback.
 *
 * SSE is only a realtime enhancement: the poll runs continuously and the
 * backend's snapshot stays authoritative, so an interrupted stream can never
 * leave the feed frozen. Hits (alertable available results) are polled from a
 * dedicated backend buffer so a fast stream of "taken" rows cannot hide them.
 * Everything is bounded and cleaned up on unmount.
 */
export function useActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);   // newest first
  const [hits, setHits] = useState<ActivityEvent[]>([]);       // oldest first
  const [connected, setConnected] = useState(false);

  const feedCursor = useRef(0);
  const hitPollCursor = useRef(0);
  const seenHits = useRef(new Set<number>());
  const pendingEvents = useRef<ActivityEvent[]>([]);           // oldest first
  const pendingHits = useRef<ActivityEvent[]>([]);
  const latestId = useRef(0);

  const ingest = useCallback((incoming: ActivityEvent[]) => {
    for (const e of incoming) {
      if (e.id > latestId.current) latestId.current = e.id;
      if (e.id > feedCursor.current) {
        feedCursor.current = e.id;
        pendingEvents.current.push(e);
      }
      if (e.status === "available" && e.alertable && !seenHits.current.has(e.id)) {
        seenHits.current.add(e.id);
        pendingHits.current.push(e);
      }
    }
    if (pendingEvents.current.length > MAX_PENDING) {
      pendingEvents.current.splice(0, pendingEvents.current.length - MAX_PENDING);
    }
    if (seenHits.current.size > MAX_HITS * 4) {
      seenHits.current = new Set([...seenHits.current].slice(-MAX_HITS * 2));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();

    // Flush buffered events into state on a timer instead of per message.
    const flushTimer = setInterval(() => {
      if (pendingEvents.current.length > 0) {
        const batch = pendingEvents.current.reverse();
        pendingEvents.current = [];
        setEvents((prev) => [...batch, ...prev].slice(0, MAX_FEED));
      }
      if (pendingHits.current.length > 0) {
        const batch = pendingHits.current;
        pendingHits.current = [];
        setHits((prev) => [...prev, ...batch].slice(-MAX_HITS));
      }
    }, FLUSH_MS);

    // Polling fallback (always on; cheap when SSE is healthy).
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (disposed) return;
      try {
        const [feedRes, hitRes] = await Promise.all([
          fetch(api(`/activity?after=${feedCursor.current}`), { signal: controller.signal }),
          fetch(api(`/activity?only=hits&after=${hitPollCursor.current}`), { signal: controller.signal }),
        ]);
        if (feedRes.ok) {
          const data = (await feedRes.json()) as { events: ActivityEvent[] };
          ingest(data.events);
        }
        if (hitRes.ok) {
          const data = (await hitRes.json()) as { events: ActivityEvent[] };
          for (const e of data.events) if (e.id > hitPollCursor.current) hitPollCursor.current = e.id;
          ingest(data.events);
        }
      } catch {
        /* network error or abort: try again on the next tick */
      } finally {
        if (!disposed) pollTimer = setTimeout(poll, document.hidden ? POLL_MS * 3 : POLL_MS);
      }
    };
    void poll();

    // SSE (realtime enhancement).
    let es: EventSource | null = null;
    try {
      es = new EventSource(api("/activity/stream"));
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false); // the browser retries automatically
      es.addEventListener("activity", (msg) => {
        try {
          ingest([JSON.parse((msg as MessageEvent<string>).data) as ActivityEvent]);
        } catch {
          /* ignore a malformed frame */
        }
      });
    } catch {
      setConnected(false);
    }

    return () => {
      disposed = true;
      controller.abort();
      clearInterval(flushTimer);
      if (pollTimer) clearTimeout(pollTimer);
      es?.close();
    };
  }, [ingest]);

  /** Clears only what this browser is showing; the backend log is untouched. */
  const clear = useCallback(() => {
    pendingEvents.current = [];
    setEvents([]);
  }, []);

  const latestEventId = useCallback(() => latestId.current, []);

  return { events, hits, connected, clear, latestEventId };
}

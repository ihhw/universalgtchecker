import type { Response } from "express";
import { recordCheck } from "./stats";

/**
 * Bounded, in-memory activity log of real checker events.
 *
 * Every entry is produced by an actual backend check; nothing here is ever
 * generated or simulated. The buffer is capped so a long-running search
 * cannot grow memory without bound.
 */

export type ActivityPlatform = "xbox";
export type ActivityStatus = "available" | "taken" | "unknown";

export interface ActivityEvent {
  id: number;
  ts: number;
  username: string;
  platform: ActivityPlatform;
  format: string;
  status: ActivityStatus;
  alertable: boolean;
  /** Secondary policy (Double Check) status, when it ran. */
  policy?: string;
  sessionId?: string;
}

const MAX_EVENTS = 500;
const events: ActivityEvent[] = [];
// Alertable hits are kept in their own bounded buffer so a fast stream of
// taken results can never push a real hit out of the polling window.
const MAX_HITS = 200;
const hits: ActivityEvent[] = [];
const clients = new Set<Response>();
let nextId = 1;

export function pushActivity(input: Omit<ActivityEvent, "id" | "ts">): ActivityEvent {
  const event: ActivityEvent = { id: nextId++, ts: Date.now(), ...input };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  recordCheck(event.status);
  if (event.status === "available" && event.alertable) {
    hits.push(event);
    if (hits.length > MAX_HITS) hits.splice(0, hits.length - MAX_HITS);
  }

  if (clients.size > 0) {
    const payload = `id: ${event.id}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try { client.write(payload); } catch { clients.delete(client); }
    }
  }
  return event;
}

/** Events with id greater than `afterId`, oldest first, capped at `limit`. */
export function listActivity(afterId = 0, limit = 200, onlyHits = false): ActivityEvent[] {
  const out = (onlyHits ? hits : events).filter((e) => e.id > afterId);
  return out.length > limit ? out.slice(out.length - limit) : out;
}

export function latestActivityId(): number {
  return events.length > 0 ? events[events.length - 1]!.id : 0;
}

export function addActivityClient(res: Response): () => void {
  clients.add(res);
  return () => { clients.delete(res); };
}

export function activityClientCount(): number {
  return clients.size;
}

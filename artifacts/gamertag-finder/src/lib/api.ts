export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Absolute-path helper for calls to the Express API (works under any base path). */
export const api = (path: string): string => `${BASE}/api${path}`;

export type Platform = "xbox";
export type FeedStatus = "available" | "taken" | "unknown";

/** Shape of an event emitted by the backend activity log. */
export interface ActivityEvent {
  id: number;
  ts: number;
  username: string;
  platform: Platform;
  /** Short mode label, e.g. LETTERS. */
  format: string;
  status: FeedStatus;
  /** True only for a confirmed hit: primary available and, with Double Check on, policy approved. */
  alertable: boolean;
  /** Double Check policy status, when it ran. */
  policy?: string;
  sessionId?: string;
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  xbox: "Xbox",
};

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable or full: preferences simply won't persist */
  }
}

/**
 * Persistent "recently confirmed taken" cache for the Checker.
 *
 * Every search session used to start from zero knowledge: re-running an
 * overlapping pattern, restarting after a crash, or looping the same finite
 * space (e.g. watching the whole 3-character namespace) re-spent a full CDN
 * check — and sometimes a reserve probe — on names already conclusively
 * known to be taken minutes or hours earlier. That's real Xbox rate-limit
 * budget spent re-learning old news instead of covering new ground.
 *
 * This cache only ever remembers TAKEN results (available ones are already
 * tracked forever via results.txt in routes/gamertag.ts — a name is never
 * re-alerted once shown). A taken verdict is remembered for a bounded
 * freshness window, not forever, since a taken name can genuinely free up
 * later (banned/deleted accounts, expired reservations).
 */

import fs from "fs";
import path from "path";
import { logger } from "./logger";

const FILE = path.join(process.cwd(), "checked-cache.json");
/** How long a "taken" verdict is trusted before it's worth re-checking. */
export const TAKEN_FRESHNESS_MS = 24 * 60 * 60 * 1000;
/** Hard cap so a very long-running server doesn't grow this file unbounded. */
const MAX_ENTRIES = 500_000;

const takenAt = new Map<string, number>();

function normalize(gt: string): string {
  return gt.trim().toUpperCase();
}

function evictOldest(): void {
  if (takenAt.size <= MAX_ENTRIES) return;
  // Map preserves insertion order; the oldest entries were inserted first
  // often enough (re-marks re-insert-on-write below) to make this a
  // reasonable, cheap approximation of true LRU.
  const excess = takenAt.size - MAX_ENTRIES;
  let i = 0;
  for (const key of takenAt.keys()) {
    if (i++ >= excess) break;
    takenAt.delete(key);
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 3_000);
  persistTimer.unref();
}

function persistNow(): void {
  try {
    fs.writeFileSync(FILE, JSON.stringify([...takenAt.entries()]), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Could not persist checked-cache");
  }
}

/** True when `gt` was confirmed taken within the freshness window — safe to skip re-checking. */
export function isRecentlyTaken(gt: string): boolean {
  const at = takenAt.get(normalize(gt));
  if (at === undefined) return false;
  if (Date.now() - at > TAKEN_FRESHNESS_MS) {
    takenAt.delete(normalize(gt));
    return false;
  }
  return true;
}

/** Records a fresh "taken" verdict, replacing any earlier one for the same name. */
export function markTaken(gt: string): void {
  const key = normalize(gt);
  takenAt.delete(key); // re-insert at the end so eviction approximates LRU
  takenAt.set(key, Date.now());
  evictOldest();
  schedulePersist();
}

/** Clears a name's cached "taken" verdict (e.g. it turned out to be available after all). */
export function clearTaken(gt: string): void {
  takenAt.delete(normalize(gt));
}

export function checkedCacheSize(): number {
  return takenAt.size;
}

export function initCheckedCache(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as unknown;
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    for (const entry of raw) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, at] = entry as [unknown, unknown];
      if (typeof key !== "string" || typeof at !== "number") continue;
      if (now - at > TAKEN_FRESHNESS_MS) continue; // don't load stale entries at all
      takenAt.set(key, at);
    }
  } catch { /* no saved cache yet */ }
}

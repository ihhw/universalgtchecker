/**
 * Day-bucketed counters for the Analytics dashboard.
 *
 * Every number here comes from a real backend event at the moment it
 * happened — a check result or a finalized claim outcome — via the two
 * integration points below (recordCheck / recordClaim). Nothing is
 * estimated or backfilled. Buckets persist to stats.json so history
 * survives a restart, unlike the in-memory activity/claim logs which are
 * capped and reset.
 */

import fs from "fs";
import path from "path";
import { logger } from "./logger";

export type CheckStatus = "available" | "taken" | "unknown";

export interface DayBucket {
  date: string; // YYYY-MM-DD, UTC
  checks: number;
  available: number;
  taken: number;
  unknown: number;
  claimAttempts: number;
  claimsSucceeded: number;
  claimsFailed: number;
}

const FILE = path.join(process.cwd(), "stats.json");
const RETENTION_DAYS = 90;

const buckets = new Map<string, DayBucket>();

function dateKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function emptyBucket(date: string): DayBucket {
  return { date, checks: 0, available: 0, taken: 0, unknown: 0, claimAttempts: 0, claimsSucceeded: 0, claimsFailed: 0 };
}

function evictOld(): void {
  if (buckets.size <= RETENTION_DAYS) return;
  const keys = [...buckets.keys()].sort();
  while (buckets.size > RETENTION_DAYS) buckets.delete(keys.shift()!);
}

function bucket(ts = Date.now()): DayBucket {
  const key = dateKey(ts);
  let b = buckets.get(key);
  if (!b) {
    b = emptyBucket(key);
    buckets.set(key, b);
    evictOld();
  }
  return b;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 2_000);
  persistTimer.unref();
}

function persistNow(): void {
  try {
    fs.writeFileSync(FILE, JSON.stringify([...buckets.values()]), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Could not persist stats");
  }
}

export function recordCheck(status: CheckStatus): void {
  const b = bucket();
  b.checks++;
  b[status]++;
  schedulePersist();
}

export function recordClaim(succeeded: boolean): void {
  const b = bucket();
  b.claimAttempts++;
  if (succeeded) b.claimsSucceeded++; else b.claimsFailed++;
  schedulePersist();
}

export interface StatsSummary {
  /** Day series, oldest first, for the requested window. */
  days: DayBucket[];
  /** Sum over every retained day (up to RETENTION_DAYS), not just the window. */
  totals: Omit<DayBucket, "date">;
}

export function getStats(days = 30): StatsSummary {
  const sortedKeys = [...buckets.keys()].sort();
  const windowKeys = sortedKeys.slice(-Math.max(1, Math.min(days, RETENTION_DAYS)));
  const series = windowKeys.map((k) => buckets.get(k)!);

  const totals = sortedKeys.reduce<Omit<DayBucket, "date">>((acc, k) => {
    const b = buckets.get(k)!;
    acc.checks += b.checks; acc.available += b.available; acc.taken += b.taken; acc.unknown += b.unknown;
    acc.claimAttempts += b.claimAttempts; acc.claimsSucceeded += b.claimsSucceeded; acc.claimsFailed += b.claimsFailed;
    return acc;
  }, { checks: 0, available: 0, taken: 0, unknown: 0, claimAttempts: 0, claimsSucceeded: 0, claimsFailed: 0 });

  return { days: series, totals };
}

export function initStats(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as unknown;
    if (!Array.isArray(raw)) return;
    for (const b of raw) {
      if (b && typeof b === "object" && typeof (b as { date?: unknown }).date === "string") {
        const d = b as Partial<DayBucket> & { date: string };
        buckets.set(d.date, {
          date: d.date,
          checks: d.checks ?? 0, available: d.available ?? 0, taken: d.taken ?? 0, unknown: d.unknown ?? 0,
          claimAttempts: d.claimAttempts ?? 0, claimsSucceeded: d.claimsSucceeded ?? 0, claimsFailed: d.claimsFailed ?? 0,
        });
      }
    }
    evictOld();
  } catch { /* no saved stats */ }
}

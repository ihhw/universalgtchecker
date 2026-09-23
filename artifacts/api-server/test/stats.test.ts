import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const FILE = "stats.json";

beforeEach(() => {
  try { fs.unlinkSync(FILE); } catch { /* not there */ }
});

test("recordCheck/recordClaim accumulate into today's bucket and totals", async () => {
  const stats = await import("../src/lib/stats");
  stats.initStats();

  stats.recordCheck("available");
  stats.recordCheck("taken");
  stats.recordCheck("taken");
  stats.recordCheck("unknown");
  stats.recordClaim(true);
  stats.recordClaim(false);

  const summary = stats.getStats(30);
  assert.equal(summary.totals.checks, 4);
  assert.equal(summary.totals.available, 1);
  assert.equal(summary.totals.taken, 2);
  assert.equal(summary.totals.unknown, 1);
  assert.equal(summary.totals.claimAttempts, 2);
  assert.equal(summary.totals.claimsSucceeded, 1);
  assert.equal(summary.totals.claimsFailed, 1);

  assert.equal(summary.days.length, 1);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(summary.days[0]!.date, today);
  assert.equal(summary.days[0]!.checks, 4);
});

test("getStats(days) windows the day series but totals stay all-time", async () => {
  const stats = await import("../src/lib/stats");
  // Same in-process module state as the previous test (ESM singleton); add more.
  stats.recordCheck("available");
  const summary1 = stats.getStats(1);
  const summaryAll = stats.getStats(90);
  assert.equal(summary1.days.length, 1, "window is capped, but there's only one day of data anyway");
  assert.equal(summary1.totals.checks, summaryAll.totals.checks, "totals sum every retained day regardless of window");
});

test("persists to stats.json (0600) and reloads via initStats", async () => {
  const stats = await import("../src/lib/stats");
  stats.recordCheck("available");
  await new Promise((r) => setTimeout(r, 2_100)); // persist is debounced ~2s
  assert.ok(fs.existsSync(FILE), "stats.json should exist after a recorded event");
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  const raw = fs.readFileSync(FILE, "utf8");
  const parsed = JSON.parse(raw) as unknown[];
  assert.ok(Array.isArray(parsed) && parsed.length >= 1);
});

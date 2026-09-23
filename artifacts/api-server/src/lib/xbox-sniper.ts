/**
 * Xbox Sniper — watches one or more target gamertags and, when a check
 * definitively reports one available, claims it for the connected Xbox
 * account. Each target runs its own independent watch loop; watching
 * several targets at once just means several loops running concurrently.
 *
 * The backend run is authoritative: it keeps going whether or not a browser
 * is connected, and state for every target is persisted to sniper.json so a
 * server restart resumes watching. SSE is only a realtime push of the same
 * snapshots the polling endpoint returns.
 *
 * Availability uses exactly the Checker's mechanism (xbox-availability.ts):
 * CDN primary check, then — with Double Check on — the Xbox reserve policy
 * check, which must return `approved`. Claims go through the shared claim
 * engine, which only reports CLAIMED when Xbox confirms it.
 *
 * Every activity entry is produced by a real backend step; nothing is
 * simulated.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { logger } from "./logger";
import { isBlockedByContentFilter } from "./content-filter";
import { validateXboxGamertag } from "./xbox-validation";
import { checkViaCDNDetailed, runEthanPolicyCheck, wait } from "./xbox-availability";
import {
  claimGamertag, claimStateLabel, notifyClaimWebhook, warmClaimConnection,
  type ClaimRecord, type ClaimState,
} from "./xbox-claim";
import { getActiveAccountStatus, verifyActiveAccount, type ActiveAccountStatus } from "./xbox-auth";
import { warmConnection } from "./xbox-http";
import { recordCheck, type CheckStatus } from "./stats";

export const MIN_INTERVAL_MS = 500;
export const MAX_INTERVAL_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 1_500;
/** How many targets may be actively watching (not just stored) at once. */
export const MAX_TARGETS = 5;
/** Total target slots kept (active + stopped history); oldest stopped one is evicted beyond this. */
const MAX_STORED_TARGETS = 20;
const MAX_EVENTS = 300;
const WARM_EVERY_MS = 20_000;
const MAX_BACKOFF_MS = 120_000;

export interface SniperConfig {
  target:        string;
  intervalMs:    number;
  autoClaim:     boolean;
  notifications: boolean;
  doubleCheck:   boolean;
}

export type SniperState = "idle" | "watching" | "claiming" | "claimed" | "stopped" | "error";
export type Availability =
  | "unknown" | "taken" | "available" | "invalid" | "rate_limited" | "network_error" | "auth_error";
export type ClaimView = "waiting" | "disabled" | ClaimState;

export interface SniperEvent {
  seq:     number;
  ts:      number;
  level:   "info" | "check" | "taken" | "available" | "claim" | "success" | "warn" | "error";
  message: string;
}

interface Latency {
  /** Last check: request start → classification (CDN + Double Check). */
  availabilityMs:    number | null;
  /** Rolling average of availabilityMs over this run. */
  avgAvailabilityMs: number | null;
  /** Last claim: claim start → Xbox's final answer. */
  claimMs:           number | null;
  /** Availability confirmed → claim request handed to the network. */
  reactionMs:        number | null;
  /** Check start → claim outcome (end-to-end). */
  totalMs:           number | null;
}

/** Persisted, per-target state. `id` is the stable slot address (survives stop/restart). */
interface Persisted {
  id:             string;
  /** Guards against a stale async loop from a previous launch of this same id. */
  runId:          string | null;
  state:          SniperState;
  config:         SniperConfig;
  availability:   Availability;
  availabilityDetail: string | null;
  claim:          ClaimView;
  claimReason:    string | null;
  checks:         number;
  claimAttempts:  number;
  lastCheckAt:    number | null;
  lastClaimAt:    number | null;
  nextCheckAt:    number | null;
  backoffUntil:   number | null;
  startedAt:      number | null;
  stoppedAt:      number | null;
  stopReason:     string | null;
  latency:        Latency;
  lastClaim:      ClaimRecord | null;
  eventSeq:       number;
  events:         SniperEvent[];
  createdAt:      number;
}

export type SniperSnapshot = Persisted & { account: ActiveAccountStatus };

/** Runtime-only state for one target's active loop; never persisted. */
interface TargetRun {
  abort:              AbortController | null;
  warmTimer:          ReturnType<typeof setInterval> | null;
  availSum:           number;
  availCount:         number;
  rateBackoffMs:      number;
  claimCooldownUntil: number;
  claimCooldownMs:    number;
  notifiedFailures:   Set<string>;
  snap:               Persisted;
}

const FILE = path.join(process.cwd(), "sniper.json");

function defaultConfig(): SniperConfig {
  return { target: "", intervalMs: DEFAULT_INTERVAL_MS, autoClaim: true, notifications: true, doubleCheck: true };
}

function freshPersisted(id: string): Persisted {
  return {
    id, runId: null, state: "idle", config: defaultConfig(),
    availability: "unknown", availabilityDetail: null, claim: "waiting", claimReason: null,
    checks: 0, claimAttempts: 0, lastCheckAt: null, lastClaimAt: null, nextCheckAt: null, backoffUntil: null,
    startedAt: null, stoppedAt: null, stopReason: null,
    latency: { availabilityMs: null, avgAvailabilityMs: null, claimMs: null, reactionMs: null, totalMs: null },
    lastClaim: null, eventSeq: 0, events: [], createdAt: Date.now(),
  };
}

const runs = new Map<string, TargetRun>();

// ─── Subscribers (SSE) ────────────────────────────────────────────────────────

type Sub = (kind: "event" | "snapshot", data: unknown) => void;
const subs = new Set<Sub>();
export function subscribeSniper(fn: Sub): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

let snapshotQueued = false;
function pushSnapshot(): void {
  // Coalesce bursts (a check emits several updates) into one frame per tick.
  if (snapshotQueued) return;
  snapshotQueued = true;
  setImmediate(() => {
    snapshotQueued = false;
    if (subs.size > 0) {
      const targets = listSniperSnapshots(20);
      for (const fn of subs) { try { fn("snapshot", { targets }); } catch { /* dead client */ } }
    }
    schedulePersist();
  });
}

function log(run: TargetRun, level: SniperEvent["level"], message: string): void {
  const e: SniperEvent = { seq: ++run.snap.eventSeq, ts: Date.now(), level, message };
  run.snap.events.push(e);
  if (run.snap.events.length > MAX_EVENTS) run.snap.events.splice(0, run.snap.events.length - MAX_EVENTS);
  for (const fn of subs) { try { fn("event", { id: run.snap.id, event: e }); } catch { /* dead client */ } }
  pushSnapshot();
}

// ─── Persistence ─────────────────────────────────────────────────────────────

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 1_000);
  persistTimer.unref();
}

function persistNow(): void {
  try {
    const targets = [...runs.values()].map((r) => ({ ...r.snap, events: r.snap.events.slice(-100) }));
    fs.writeFileSync(FILE, JSON.stringify({ targets }), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Could not persist sniper state");
  }
}

function load(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as { targets?: Partial<Persisted>[] } | Partial<Persisted>;
    // Back-compat: a pre-multi-target file was a single Persisted object, not { targets }.
    const list: Partial<Persisted>[] = Array.isArray((raw as { targets?: unknown }).targets)
      ? (raw as { targets: Partial<Persisted>[] }).targets
      : "config" in raw
        ? [{ ...(raw as Partial<Persisted>), id: crypto.randomUUID() }]
        : [];
    for (const t of list) {
      if (typeof t.id !== "string") continue;
      // A target that was never actually started (idle, no gamertag) carries no
      // useful history — dropping it also cleans up the legacy single-sniper
      // default that pre-multi-target files always contained.
      if (t.state === "idle" || !t.config?.target) continue;
      const base = freshPersisted(t.id);
      const snap: Persisted = {
        ...base, ...t,
        config: { ...defaultConfig(), ...(t.config ?? {}) },
        events: Array.isArray(t.events) ? t.events : [],
      };
      runs.set(t.id, {
        abort: null, warmTimer: null, availSum: 0, availCount: 0,
        rateBackoffMs: 0, claimCooldownUntil: 0, claimCooldownMs: 0, notifiedFailures: new Set(),
        snap,
      });
    }
  } catch { /* no saved sniper */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const now = () => performance.now();
const since = (t: number) => Math.round(now() - t);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return wait(Math.max(0, ms), signal);
}

function isActive(run: TargetRun, runId: string): boolean {
  return run.snap.runId === runId && (run.snap.state === "watching" || run.snap.state === "claiming")
    && !!run.abort && !run.abort.signal.aborted;
}

function endRun(run: TargetRun, state: Exclude<SniperState, "watching" | "claiming" | "idle">, reason: string | null): void {
  run.snap.state = state;
  run.snap.stoppedAt = Date.now();
  run.snap.stopReason = reason;
  run.snap.nextCheckAt = null;
  run.abort?.abort();
  run.abort = null;
  if (run.warmTimer) { clearInterval(run.warmTimer); run.warmTimer = null; }
  pushSnapshot();
}

function bumpRateBackoff(run: TargetRun, serverMs: number | undefined): number {
  run.rateBackoffMs = Math.min(MAX_BACKOFF_MS, Math.max(serverMs ?? 0, run.rateBackoffMs ? run.rateBackoffMs * 2 : 5_000));
  run.snap.backoffUntil = Date.now() + run.rateBackoffMs;
  return run.rateBackoffMs;
}

// ─── One check ────────────────────────────────────────────────────────────────

interface CheckOutcome { availability: Availability; detail: string; backoffMs?: number }

async function checkAvailability(run: TargetRun, target: string, signal: AbortSignal): Promise<CheckOutcome> {
  const perCheck = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  const cdn = await checkViaCDNDetailed(target, perCheck, true);
  if (signal.aborted) return { availability: "unknown", detail: "stopped" };

  if (cdn.status === null) {
    if (cdn.httpStatus === 429) {
      return { availability: "rate_limited", detail: "Xbox CDN returned HTTP 429", backoffMs: bumpRateBackoff(run, cdn.retryAfterMs) };
    }
    if (cdn.networkError) {
      return { availability: "network_error", detail: cdn.networkError === "timeout" ? "CDN request timed out (5 s)" : "CDN request failed (network)" };
    }
    return { availability: "unknown", detail: `CDN returned HTTP ${cdn.httpStatus}` };
  }
  if (cdn.status === "taken") return { availability: "taken", detail: `CDN HTTP ${cdn.httpStatus}` };

  // Primary says available.
  if (!run.snap.config.doubleCheck) {
    return { availability: "available", detail: `CDN HTTP ${cdn.httpStatus} (primary check only — Double Check off)` };
  }
  const policy = await runEthanPolicyCheck(
    target,
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    { retryOn429: false, fast: true },
  );
  switch (policy.status) {
    case "approved":
      return { availability: "available", detail: `CDN HTTP ${cdn.httpStatus} · Double Check approved (HTTP ${policy.httpStatus})` };
    case "unavailable":
      return { availability: "taken", detail: `CDN said free, Double Check says taken (HTTP ${policy.httpStatus})` };
    case "banned":
      return { availability: "invalid", detail: `Double Check: Xbox marked the gamertag unacceptable (HTTP ${policy.httpStatus})` };
    case "rate_limited":
      return { availability: "rate_limited", detail: "Double Check returned HTTP 429", backoffMs: bumpRateBackoff(run, policy.retryAfterMs) };
    case "auth_required":
    case "not_configured":
      return { availability: "auth_error", detail: `Double Check: ${policy.message ?? "authorization required"}` };
    default:
      return { availability: "unknown", detail: `Double Check: ${policy.message ?? "error"}` };
  }
}

async function runClaim(run: TargetRun, runId: string, target: string, checkStart: number, detectedAt: number): Promise<"stop" | "continue"> {
  run.snap.state = "claiming";
  run.snap.claim = "claiming";
  run.snap.claimReason = null;
  run.snap.claimAttempts++;
  run.snap.lastClaimAt = Date.now();
  const claimStart = now();
  run.snap.latency.reactionMs = Math.round(claimStart - detectedAt);
  log(run, "claim", `Claim request sent for ${target}`);

  const r = await claimGamertag(target, { source: "sniper" });
  run.snap.lastClaim = r;
  run.snap.latency.claimMs = r.latency.totalMs;
  run.snap.latency.totalMs = since(checkStart);
  run.snap.claim = r.state;
  run.snap.claimReason = r.reason;
  if (run.snap.runId !== runId) return "stop";

  const timing = `claim ${r.latency.totalMs}ms (reserve ${r.latency.reserveMs ?? "-"}ms, change ${r.latency.changeMs ?? "-"}ms), end-to-end ${run.snap.latency.totalMs}ms`;

  if (r.state === "claimed") {
    log(run, "success", `Claim confirmed by Xbox — ${target} is now this account's gamertag (${r.confirmedBy === "change_response" ? "change response" : "account identity"}; ${timing})`);
    if (run.snap.config.notifications) void notifyClaimWebhook(r, "Xbox Sniper");
    endRun(run, "claimed", null);
    return "stop";
  }

  const label = claimStateLabel(r.state);
  log(run, r.state === "rate_limited" || r.state === "network_error" ? "warn" : "error", `${label}: ${r.reason ?? "no reason given"}${r.httpStatus ? ` [HTTP ${r.httpStatus}]` : ""} (${timing})`);
  const key = `${r.state}:${r.errorCode ?? ""}`;
  if (run.snap.config.notifications && !run.notifiedFailures.has(key)) {
    run.notifiedFailures.add(key);
    void notifyClaimWebhook(r, "Xbox Sniper");
  }

  // Outcomes that retrying can't fix, or where retrying could rename twice.
  if (r.state === "auth_error") { endRun(run, "error", `Auth error: ${r.reason}`); return "stop"; }
  if (r.state === "unknown") {
    endRun(run, "error", `Claim outcome not confirmed — stopped so the account is never changed twice. ${r.reason ?? ""}`.trim());
    return "stop";
  }
  if (r.errorCode === "not_allowed" || r.errorCode === "rejected" || r.errorCode === "invalid_gamertag") {
    endRun(run, "error", r.reason);
    return "stop";
  }
  // Stopped by the user while the claim was in flight: report, don't resume.
  if (run.snap.state !== "claiming") return "stop";

  // taken / suffix_required / 5xx / network / rate limit / busy: keep watching,
  // but space out further claim attempts so a flapping result can't spam Xbox.
  if (r.state === "rate_limited") {
    const b = bumpRateBackoff(run, r.retryAfterMs);
    run.claimCooldownUntil = Date.now() + b;
  } else {
    run.claimCooldownMs = Math.min(60_000, run.claimCooldownMs ? run.claimCooldownMs * 2 : 5_000);
    run.claimCooldownUntil = Date.now() + run.claimCooldownMs;
    log(run, "info", `Next claim attempt no sooner than ${Math.round(run.claimCooldownMs / 1000)}s from now`);
  }
  run.snap.state = "watching";
  pushSnapshot();
  return "continue";
}

async function loop(run: TargetRun, runId: string, signal: AbortSignal): Promise<void> {
  const target = run.snap.config.target;
  while (isActive(run, runId)) {
    const checkStart = now();
    run.snap.lastCheckAt = Date.now();
    run.snap.checks++;
    log(run, "check", `Checking ${target}`);

    let out: CheckOutcome;
    try {
      out = await checkAvailability(run, target, signal);
    } catch (err) {
      out = { availability: "unknown", detail: `check error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!isActive(run, runId)) break;

    const availabilityMs = since(checkStart);
    run.snap.latency.availabilityMs = availabilityMs;
    run.availSum += availabilityMs; run.availCount++;
    run.snap.latency.avgAvailabilityMs = Math.round(run.availSum / run.availCount);
    run.snap.availability = out.availability;
    run.snap.availabilityDetail = out.detail;

    if (out.availability !== "rate_limited") { run.rateBackoffMs = 0; run.snap.backoffUntil = null; }
    if (out.availability === "taken") { run.claimCooldownMs = 0; run.claimCooldownUntil = 0; }

    // The dashboard's tri-state check count mirrors the Checker's: anything
    // that isn't a definitive available/taken counts as "unknown".
    const statTri: CheckStatus = out.availability === "available" || out.availability === "taken" ? out.availability : "unknown";
    recordCheck(statTri);

    const tag = `${target} — ${out.availability.replace("_", " ").toUpperCase()}`;
    switch (out.availability) {
      case "taken":         log(run, "taken", `${tag} (${out.detail}, ${availabilityMs}ms)`); break;
      case "available":     log(run, "available", `${tag} (${out.detail}, ${availabilityMs}ms)`); break;
      case "rate_limited":  log(run, "warn", `${tag} — ${out.detail}; backing off ${Math.round((out.backoffMs ?? 0) / 1000)}s`); break;
      case "auth_error":    log(run, "error", `${tag} — ${out.detail}`); break;
      default:              log(run, out.availability === "invalid" ? "error" : "warn", `${tag} (${out.detail}, ${availabilityMs}ms)`);
    }

    if (out.availability === "auth_error") {
      endRun(run, "error", out.detail);
      break;
    }

    if (out.availability === "available") {
      const detectedAt = now();
      if (!run.snap.config.autoClaim) {
        run.snap.claim = "disabled";
        run.snap.claimReason = "Auto Claim is off.";
        log(run, "info", "Auto Claim is off — not claiming");
      } else if (Date.now() < run.claimCooldownUntil) {
        log(run, "info", `Claim cooling down after the previous attempt (${Math.ceil((run.claimCooldownUntil - Date.now()) / 1000)}s left)`);
      } else {
        const next = await runClaim(run, runId, target, checkStart, detectedAt);
        if (next === "stop") break;
      }
    }

    // Fixed-rate schedule: the interval counts from the start of this check.
    let delay = run.snap.config.intervalMs - since(checkStart);
    if (run.snap.backoffUntil && run.snap.backoffUntil > Date.now()) delay = Math.max(delay, run.snap.backoffUntil - Date.now());
    run.snap.nextCheckAt = Date.now() + Math.max(0, delay);
    pushSnapshot();
    await sleep(delay, signal);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getSniperSnapshot(id: string, eventLimit = 200): SniperSnapshot | null {
  const run = runs.get(id);
  if (!run) return null;
  return { ...run.snap, events: run.snap.events.slice(-eventLimit), account: getActiveAccountStatus() };
}

export function listSniperSnapshots(eventLimit = 50): SniperSnapshot[] {
  const account = getActiveAccountStatus();
  return [...runs.values()]
    .sort((a, b) => a.snap.createdAt - b.snap.createdAt)
    .map((run) => ({ ...run.snap, events: run.snap.events.slice(-eventLimit), account }));
}

export function eventsAfter(id: string, seq: number): SniperEvent[] {
  return runs.get(id)?.snap.events.filter((e) => e.seq > seq) ?? [];
}

export function validateSniperConfig(input: Partial<SniperConfig>): { ok: true; config: SniperConfig } | { ok: false; error: string } {
  const target = typeof input.target === "string" ? input.target.trim() : "";
  const v = validateXboxGamertag(target);
  if (!v.valid) return { ok: false, error: v.errors[0] ?? "Invalid gamertag." };
  if (isBlockedByContentFilter(target)) {
    return { ok: false, error: "Xbox's content policy blocks this gamertag, so it can never be claimed." };
  }
  const interval = Number(input.intervalMs ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MS || interval > MAX_INTERVAL_MS) {
    return { ok: false, error: `Check interval must be between ${MIN_INTERVAL_MS} ms and ${MAX_INTERVAL_MS / 1000} s.` };
  }
  return {
    ok: true,
    config: {
      target,
      intervalMs: Math.round(interval),
      autoClaim: input.autoClaim !== false,
      notifications: input.notifications !== false,
      doubleCheck: input.doubleCheck !== false,
    },
  };
}

export type StartResult = { ok: true; id: string } | { ok: false; status: number; error: string };

function activeRuns(): TargetRun[] {
  return [...runs.values()].filter((r) => r.snap.state === "watching" || r.snap.state === "claiming");
}

/** Keeps the stored target list bounded by dropping the oldest non-active entry. */
function evictOldStoppedIfNeeded(): void {
  if (runs.size <= MAX_STORED_TARGETS) return;
  const candidates = [...runs.values()]
    .filter((r) => r.snap.state !== "watching" && r.snap.state !== "claiming")
    .sort((a, b) => a.snap.createdAt - b.snap.createdAt);
  const oldest = candidates[0];
  if (oldest) runs.delete(oldest.snap.id);
}

export async function startSniper(input: Partial<SniperConfig>): Promise<StartResult> {
  const v = validateSniperConfig(input);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  if (activeRuns().length >= MAX_TARGETS) {
    return { ok: false, status: 409, error: `Cannot watch more than ${MAX_TARGETS} targets at once. Stop another target first.` };
  }
  const dupe = activeRuns().find((r) => r.snap.config.target.toUpperCase() === v.config.target.toUpperCase());
  if (dupe) {
    return { ok: false, status: 409, error: `Already watching "${v.config.target}".` };
  }

  // Auto Claim and Double Check both need a fully authenticated account;
  // verify the whole chain now instead of discovering a problem at claim time.
  if (v.config.autoClaim || v.config.doubleCheck) {
    const acct = await verifyActiveAccount();
    if (!acct.ready) {
      return {
        ok: false, status: 409,
        error: `Xbox account not ready: ${acct.reason ?? "unknown reason"}${v.config.autoClaim ? "" : " (needed for Double Check)"}`,
      };
    }
  }

  const id = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const run: TargetRun = {
    abort: null, warmTimer: null, availSum: 0, availCount: 0,
    rateBackoffMs: 0, claimCooldownUntil: 0, claimCooldownMs: 0, notifiedFailures: new Set(),
    snap: {
      ...freshPersisted(id),
      runId, state: "watching", config: v.config,
      claim: v.config.autoClaim ? "waiting" : "disabled",
      startedAt: Date.now(),
    },
  };
  runs.set(id, run);
  evictOldStoppedIfNeeded();
  log(run, "info", `Sniper started — target ${v.config.target}, every ${v.config.intervalMs}ms, Auto Claim ${v.config.autoClaim ? "on" : "off"}, Double Check ${v.config.doubleCheck ? "on" : "off"}`);
  launch(run, runId);
  return { ok: true, id };
}

function launch(run: TargetRun, runId: string): void {
  run.abort = new AbortController();
  const signal = run.abort.signal;
  // Warm the TLS connections the hot path will use, and keep the claim
  // host's connection alive while watching.
  if (run.snap.config.autoClaim) {
    void warmClaimConnection();
    run.warmTimer = setInterval(() => { void warmClaimConnection(); }, WARM_EVERY_MS);
    run.warmTimer.unref();
  }
  void warmConnection("https://avatar-ssl.xboxlive.com/");
  loop(run, runId, signal).catch((err) => {
    logger.error({ err }, "Sniper loop crashed");
    if (run.snap.runId === runId) {
      log(run, "error", `Sniper stopped: internal error (${err instanceof Error ? err.message : String(err)})`);
      endRun(run, "error", "Internal error");
    }
  });
}

export function stopSniper(id: string, reason = "Stopped by user"): boolean {
  const run = runs.get(id);
  if (!run || (run.snap.state !== "watching" && run.snap.state !== "claiming")) return false;
  const wasClaiming = run.snap.state === "claiming";
  log(run, "info", wasClaiming ? `${reason} — the claim already sent to Xbox will still report its outcome` : reason);
  endRun(run, "stopped", reason);
  return true;
}

/** Stops (if running) and forgets a target entirely. */
export function removeSniper(id: string): boolean {
  const run = runs.get(id);
  if (!run) return false;
  if (run.snap.state === "watching" || run.snap.state === "claiming") stopSniper(id, "Removed by user");
  runs.delete(id);
  pushSnapshot();
  return true;
}

export function updateSniperSettings(id: string, patch: { autoClaim?: boolean; notifications?: boolean }): SniperConfig | null {
  const run = runs.get(id);
  if (!run) return null;
  if (typeof patch.autoClaim === "boolean" && patch.autoClaim !== run.snap.config.autoClaim) {
    run.snap.config.autoClaim = patch.autoClaim;
    if (run.snap.state === "watching") {
      run.snap.claim = patch.autoClaim ? "waiting" : "disabled";
      log(run, "info", `Auto Claim turned ${patch.autoClaim ? "on" : "off"}`);
    }
  }
  if (typeof patch.notifications === "boolean" && patch.notifications !== run.snap.config.notifications) {
    run.snap.config.notifications = patch.notifications;
    if (run.snap.state === "watching") log(run, "info", `Notifications turned ${patch.notifications ? "on" : "off"}`);
  }
  pushSnapshot();
  return run.snap.config;
}

/** Restore persisted state; resume any runs that were active when the server stopped. */
export function initSniper(): void {
  load();
  for (const run of runs.values()) {
    if (run.snap.state === "claiming") {
      run.snap.state = "error";
      run.snap.claim = "unknown";
      run.snap.stopReason = "The server restarted while a claim was in flight; its outcome was not observed. Check the account's gamertag.";
      log(run, "error", run.snap.stopReason);
    } else if (run.snap.state === "watching" && run.snap.runId) {
      log(run, "info", "Sniper resumed after a server restart");
      launch(run, run.snap.runId);
    }
  }
  // Adding a signal listener replaces Node's default exit, so exit explicitly.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => { persistNow(); process.exit(0); });
  }
}

export function sniperStats(): { running: boolean; subscribers: number; active: number } {
  const active = activeRuns().length;
  return { running: active > 0, subscribers: subs.size, active };
}

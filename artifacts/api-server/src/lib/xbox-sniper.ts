/**
 * Xbox Sniper — watches ONE target gamertag and, when a check definitively
 * reports it available, claims it for the connected Xbox account.
 *
 * The backend run is authoritative: it keeps going whether or not a browser
 * is connected, and its state is persisted to sniper.json so a server restart
 * resumes watching. SSE is only a realtime push of the same snapshot the
 * polling endpoint returns.
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

export const MIN_INTERVAL_MS = 500;
export const MAX_INTERVAL_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 1_500;
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

export interface SniperSnapshot {
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
  account:        ActiveAccountStatus;
  eventSeq:       number;
  events:         SniperEvent[];
}

type Persisted = Omit<SniperSnapshot, "account">;

const FILE = path.join(process.cwd(), "sniper.json");

function defaultConfig(): SniperConfig {
  return { target: "", intervalMs: DEFAULT_INTERVAL_MS, autoClaim: true, notifications: true, doubleCheck: true };
}

const s: Persisted = {
  runId: null, state: "idle", config: defaultConfig(),
  availability: "unknown", availabilityDetail: null, claim: "waiting", claimReason: null,
  checks: 0, claimAttempts: 0, lastCheckAt: null, lastClaimAt: null, nextCheckAt: null, backoffUntil: null,
  startedAt: null, stoppedAt: null, stopReason: null,
  latency: { availabilityMs: null, avgAvailabilityMs: null, claimMs: null, reactionMs: null, totalMs: null },
  lastClaim: null, eventSeq: 0, events: [],
};

let abort: AbortController | null = null;
let warmTimer: ReturnType<typeof setInterval> | null = null;
let availSum = 0;
let availCount = 0;
let rateBackoffMs = 0;
let claimCooldownUntil = 0;
let claimCooldownMs = 0;
const notifiedFailures = new Set<string>();

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
      const snap = getSniperSnapshot(20);
      for (const fn of subs) { try { fn("snapshot", snap); } catch { /* dead client */ } }
    }
    schedulePersist();
  });
}

function log(level: SniperEvent["level"], message: string): void {
  const e: SniperEvent = { seq: ++s.eventSeq, ts: Date.now(), level, message };
  s.events.push(e);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  for (const fn of subs) { try { fn("event", e); } catch { /* dead client */ } }
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
    const data: Persisted = { ...s, events: s.events.slice(-100) };
    fs.writeFileSync(FILE, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Could not persist sniper state");
  }
}

function load(): void {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<Persisted>;
    Object.assign(s, d, { config: { ...defaultConfig(), ...(d.config ?? {}) } });
    s.events = Array.isArray(d.events) ? d.events : [];
  } catch { /* no saved sniper */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const now = () => performance.now();
const since = (t: number) => Math.round(now() - t);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return wait(Math.max(0, ms), signal);
}

function isActive(runId: string): boolean {
  return s.runId === runId && (s.state === "watching" || s.state === "claiming") && !!abort && !abort.signal.aborted;
}

function endRun(state: Exclude<SniperState, "watching" | "claiming" | "idle">, reason: string | null): void {
  s.state = state;
  s.stoppedAt = Date.now();
  s.stopReason = reason;
  s.nextCheckAt = null;
  abort?.abort();
  abort = null;
  if (warmTimer) { clearInterval(warmTimer); warmTimer = null; }
  pushSnapshot();
}

function bumpRateBackoff(serverMs: number | undefined): number {
  rateBackoffMs = Math.min(MAX_BACKOFF_MS, Math.max(serverMs ?? 0, rateBackoffMs ? rateBackoffMs * 2 : 5_000));
  s.backoffUntil = Date.now() + rateBackoffMs;
  return rateBackoffMs;
}

// ─── One check ────────────────────────────────────────────────────────────────

interface CheckOutcome { availability: Availability; detail: string; backoffMs?: number }

async function checkAvailability(target: string, signal: AbortSignal): Promise<CheckOutcome> {
  const perCheck = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  const cdn = await checkViaCDNDetailed(target, perCheck, true);
  if (signal.aborted) return { availability: "unknown", detail: "stopped" };

  if (cdn.status === null) {
    if (cdn.httpStatus === 429) {
      return { availability: "rate_limited", detail: "Xbox CDN returned HTTP 429", backoffMs: bumpRateBackoff(cdn.retryAfterMs) };
    }
    if (cdn.networkError) {
      return { availability: "network_error", detail: cdn.networkError === "timeout" ? "CDN request timed out (5 s)" : "CDN request failed (network)" };
    }
    return { availability: "unknown", detail: `CDN returned HTTP ${cdn.httpStatus}` };
  }
  if (cdn.status === "taken") return { availability: "taken", detail: `CDN HTTP ${cdn.httpStatus}` };

  // Primary says available.
  if (!s.config.doubleCheck) {
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
      return { availability: "rate_limited", detail: "Double Check returned HTTP 429", backoffMs: bumpRateBackoff(policy.retryAfterMs) };
    case "auth_required":
    case "not_configured":
      return { availability: "auth_error", detail: `Double Check: ${policy.message ?? "authorization required"}` };
    default:
      return { availability: "unknown", detail: `Double Check: ${policy.message ?? "error"}` };
  }
}

async function runClaim(runId: string, target: string, checkStart: number, detectedAt: number): Promise<"stop" | "continue"> {
  s.state = "claiming";
  s.claim = "claiming";
  s.claimReason = null;
  s.claimAttempts++;
  s.lastClaimAt = Date.now();
  const claimStart = now();
  s.latency.reactionMs = Math.round(claimStart - detectedAt);
  log("claim", `Claim request sent for ${target}`);

  const r = await claimGamertag(target, { source: "sniper" });
  s.lastClaim = r;
  s.latency.claimMs = r.latency.totalMs;
  s.latency.totalMs = since(checkStart);
  s.claim = r.state;
  s.claimReason = r.reason;
  if (s.runId !== runId) return "stop";

  const timing = `claim ${r.latency.totalMs}ms (reserve ${r.latency.reserveMs ?? "-"}ms, change ${r.latency.changeMs ?? "-"}ms), end-to-end ${s.latency.totalMs}ms`;

  if (r.state === "claimed") {
    log("success", `Claim confirmed by Xbox — ${target} is now this account's gamertag (${r.confirmedBy === "change_response" ? "change response" : "account identity"}; ${timing})`);
    if (s.config.notifications) void notifyClaimWebhook(r, "Xbox Sniper");
    endRun("claimed", null);
    return "stop";
  }

  const label = claimStateLabel(r.state);
  log(r.state === "rate_limited" || r.state === "network_error" ? "warn" : "error", `${label}: ${r.reason ?? "no reason given"}${r.httpStatus ? ` [HTTP ${r.httpStatus}]` : ""} (${timing})`);
  const key = `${r.state}:${r.errorCode ?? ""}`;
  if (s.config.notifications && !notifiedFailures.has(key)) {
    notifiedFailures.add(key);
    void notifyClaimWebhook(r, "Xbox Sniper");
  }

  // Outcomes that retrying can't fix, or where retrying could rename twice.
  if (r.state === "auth_error") { endRun("error", `Auth error: ${r.reason}`); return "stop"; }
  if (r.state === "unknown") {
    endRun("error", `Claim outcome not confirmed — stopped so the account is never changed twice. ${r.reason ?? ""}`.trim());
    return "stop";
  }
  if (r.errorCode === "not_allowed" || r.errorCode === "rejected" || r.errorCode === "invalid_gamertag") {
    endRun("error", r.reason);
    return "stop";
  }
  // Stopped by the user while the claim was in flight: report, don't resume.
  if (s.state !== "claiming") return "stop";

  // taken / suffix_required / 5xx / network / rate limit / busy: keep watching,
  // but space out further claim attempts so a flapping result can't spam Xbox.
  if (r.state === "rate_limited") {
    const b = bumpRateBackoff(r.retryAfterMs);
    claimCooldownUntil = Date.now() + b;
  } else {
    claimCooldownMs = Math.min(60_000, claimCooldownMs ? claimCooldownMs * 2 : 5_000);
    claimCooldownUntil = Date.now() + claimCooldownMs;
    log("info", `Next claim attempt no sooner than ${Math.round(claimCooldownMs / 1000)}s from now`);
  }
  s.state = "watching";
  pushSnapshot();
  return "continue";
}

async function loop(runId: string, signal: AbortSignal): Promise<void> {
  const target = s.config.target;
  while (isActive(runId)) {
    const checkStart = now();
    s.lastCheckAt = Date.now();
    s.checks++;
    log("check", `Checking ${target}`);

    let out: CheckOutcome;
    try {
      out = await checkAvailability(target, signal);
    } catch (err) {
      out = { availability: "unknown", detail: `check error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!isActive(runId)) break;

    const availabilityMs = since(checkStart);
    s.latency.availabilityMs = availabilityMs;
    availSum += availabilityMs; availCount++;
    s.latency.avgAvailabilityMs = Math.round(availSum / availCount);
    s.availability = out.availability;
    s.availabilityDetail = out.detail;

    if (out.availability !== "rate_limited") { rateBackoffMs = 0; s.backoffUntil = null; }
    if (out.availability === "taken") { claimCooldownMs = 0; claimCooldownUntil = 0; }

    const tag = `${target} — ${out.availability.replace("_", " ").toUpperCase()}`;
    switch (out.availability) {
      case "taken":         log("taken", `${tag} (${out.detail}, ${availabilityMs}ms)`); break;
      case "available":     log("available", `${tag} (${out.detail}, ${availabilityMs}ms)`); break;
      case "rate_limited":  log("warn", `${tag} — ${out.detail}; backing off ${Math.round((out.backoffMs ?? 0) / 1000)}s`); break;
      case "auth_error":    log("error", `${tag} — ${out.detail}`); break;
      default:              log(out.availability === "invalid" ? "error" : "warn", `${tag} (${out.detail}, ${availabilityMs}ms)`);
    }

    if (out.availability === "auth_error") {
      endRun("error", out.detail);
      break;
    }

    if (out.availability === "available") {
      const detectedAt = now();
      if (!s.config.autoClaim) {
        s.claim = "disabled";
        s.claimReason = "Auto Claim is off.";
        log("info", "Auto Claim is off — not claiming");
      } else if (Date.now() < claimCooldownUntil) {
        log("info", `Claim cooling down after the previous attempt (${Math.ceil((claimCooldownUntil - Date.now()) / 1000)}s left)`);
      } else {
        const next = await runClaim(runId, target, checkStart, detectedAt);
        if (next === "stop") break;
      }
    }

    // Fixed-rate schedule: the interval counts from the start of this check.
    let delay = s.config.intervalMs - since(checkStart);
    if (s.backoffUntil && s.backoffUntil > Date.now()) delay = Math.max(delay, s.backoffUntil - Date.now());
    s.nextCheckAt = Date.now() + Math.max(0, delay);
    pushSnapshot();
    await sleep(delay, signal);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getSniperSnapshot(eventLimit = 200): SniperSnapshot {
  return {
    ...s,
    lastClaim: s.lastClaim,
    events: s.events.slice(-eventLimit),
    account: getActiveAccountStatus(),
  };
}

export function eventsAfter(seq: number): SniperEvent[] {
  return s.events.filter((e) => e.seq > seq);
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

export type StartResult = { ok: true } | { ok: false; status: number; error: string };

export async function startSniper(input: Partial<SniperConfig>): Promise<StartResult> {
  if (s.state === "watching" || s.state === "claiming") {
    return { ok: false, status: 409, error: "The sniper is already running. Stop it first." };
  }
  const v = validateSniperConfig(input);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

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

  const runId = crypto.randomUUID();
  Object.assign(s, {
    runId, state: "watching" as SniperState, config: v.config,
    availability: "unknown" as Availability, availabilityDetail: null,
    claim: (v.config.autoClaim ? "waiting" : "disabled") as ClaimView, claimReason: null,
    checks: 0, claimAttempts: 0, lastCheckAt: null, lastClaimAt: null, nextCheckAt: null, backoffUntil: null,
    startedAt: Date.now(), stoppedAt: null, stopReason: null,
    latency: { availabilityMs: null, avgAvailabilityMs: null, claimMs: null, reactionMs: null, totalMs: null },
    lastClaim: null,
  });
  availSum = 0; availCount = 0; rateBackoffMs = 0; claimCooldownUntil = 0; claimCooldownMs = 0;
  notifiedFailures.clear();
  log("info", `Sniper started — target ${v.config.target}, every ${v.config.intervalMs}ms, Auto Claim ${v.config.autoClaim ? "on" : "off"}, Double Check ${v.config.doubleCheck ? "on" : "off"}`);
  launch(runId);
  return { ok: true };
}

function launch(runId: string): void {
  abort = new AbortController();
  const signal = abort.signal;
  // Warm the TLS connections the hot path will use, and keep the claim
  // host's connection alive while watching.
  if (s.config.autoClaim) {
    void warmClaimConnection();
    warmTimer = setInterval(() => { void warmClaimConnection(); }, WARM_EVERY_MS);
    warmTimer.unref();
  }
  void warmConnection("https://avatar-ssl.xboxlive.com/");
  loop(runId, signal).catch((err) => {
    logger.error({ err }, "Sniper loop crashed");
    if (s.runId === runId) {
      log("error", `Sniper stopped: internal error (${err instanceof Error ? err.message : String(err)})`);
      endRun("error", "Internal error");
    }
  });
}

export function stopSniper(reason = "Stopped by user"): boolean {
  if (s.state !== "watching" && s.state !== "claiming") return false;
  const wasClaiming = s.state === "claiming";
  log("info", wasClaiming ? `${reason} — the claim already sent to Xbox will still report its outcome` : reason);
  endRun("stopped", reason);
  return true;
}

export function updateSniperSettings(patch: { autoClaim?: boolean; notifications?: boolean }): SniperConfig {
  if (typeof patch.autoClaim === "boolean" && patch.autoClaim !== s.config.autoClaim) {
    s.config.autoClaim = patch.autoClaim;
    if (s.state === "watching") {
      s.claim = patch.autoClaim ? "waiting" : "disabled";
      log("info", `Auto Claim turned ${patch.autoClaim ? "on" : "off"}`);
    }
  }
  if (typeof patch.notifications === "boolean" && patch.notifications !== s.config.notifications) {
    s.config.notifications = patch.notifications;
    if (s.state === "watching") log("info", `Notifications turned ${patch.notifications ? "on" : "off"}`);
  }
  pushSnapshot();
  return s.config;
}

/** Restore persisted state; resume a run that was active when the server stopped. */
export function initSniper(): void {
  load();
  if (s.state === "claiming") {
    s.state = "error";
    s.claim = "unknown";
    s.stopReason = "The server restarted while a claim was in flight; its outcome was not observed. Check the account's gamertag.";
    log("error", s.stopReason);
  } else if (s.state === "watching" && s.runId) {
    log("info", "Sniper resumed after a server restart");
    launch(s.runId);
  }
  // Adding a signal listener replaces Node's default exit, so exit explicitly.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => { persistNow(); process.exit(0); });
  }
}

export function sniperStats(): { running: boolean; subscribers: number } {
  return { running: s.state === "watching" || s.state === "claiming", subscribers: subs.size };
}

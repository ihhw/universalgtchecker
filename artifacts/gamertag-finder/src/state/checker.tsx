import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { GamertagSearchInput, GamertagSession, GenerationMode } from "@workspace/api-client-react";
import { api, readStored, writeStored, type ActivityEvent } from "@/lib/api";
import {
  BUILTIN_TEMPLATES, MODE_BY_ID, defaultParamsByMode, persistableParams,
  type Params, type TemplateDef,
} from "@/lib/modes";
import { useActivityFeed } from "@/hooks/use-activity-feed";
import { useSessionSnapshot, type SessionSnapshot } from "@/hooks/use-session-snapshot";
import { useXboxAuth } from "@/hooks/use-xbox-auth";

/**
 * Claim states come from the backend claim engine. "claimed" is only ever
 * set when Xbox confirmed the exact gamertag for the connected account.
 */
export type ClaimStatus =
  | "idle" | "claiming" | "claimed" | "claim_failed"
  | "auth_error" | "rate_limited" | "network_error" | "unknown";

/** A claim record as reported by GET /api/gamertag/claims. */
export interface ClaimRecord {
  id: number;
  gamertag: string;
  source: "manual" | "checker" | "sniper";
  sessionId?: string;
  state: Exclude<ClaimStatus, "idle">;
  errorCode: string | null;
  reason: string | null;
  httpStatus: number | null;
  confirmedBy: "change_response" | "xsts_identity" | null;
  startedAt: number;
  finishedAt: number | null;
  latency: { totalMs: number | null; reserveMs: number | null; changeMs: number | null };
}

export interface ConfigValidation {
  status: "checking" | "ok" | "error";
  errors: string[];
  label: string;
  /** List mode: number of names, and invalid entries skipped on request. */
  info: { count?: number; skipped?: number };
  /** A handful of example names these settings could produce. */
  samples: string[];
}

const SESSION_KEY = "universal-xbox-session";
const SAVED_KEY = "gtag-saved";
const DOUBLE_CHECK_KEY = "gtag-ethan-policy";
const LEGACY_CHECKER_KEY = "gtag-legacy-checker";
const AUTOCLAIM_KEY = "gtag-autoclaim";
const RATE_KEY = "universal-xbox-rate";
/** Ceiling with no proxies configured; the server raises this once proxies are set. */
export const DEFAULT_MAX_RATE = 50;
const MODE_KEY = "universal-xbox-mode";
const PARAMS_KEY = "universal-xbox-params";
const TEMPLATES_KEY = "universal-xbox-templates";
const MAX_SAVED_TEMPLATES = 20;

interface CheckerContextValue {
  // generation settings
  mode: string;
  setMode: (id: string) => void;
  params: Params;
  setParams: (patch: Params) => void;
  validation: ConfigValidation;
  builtinTemplates: TemplateDef[];
  savedTemplates: TemplateDef[];
  applyTemplate: (t: TemplateDef) => void;
  saveTemplate: (name: string) => void;
  deleteTemplate: (id: string) => void;
  templateSourceLabel: string;
  // search settings
  rate: number;
  setRate: (n: number) => void;
  /** Current server-enforced rate ceiling (higher once proxies are configured). */
  maxRate: number;
  proxyCount: number;
  refreshProxyState: () => Promise<void>;
  doubleCheck: boolean;
  setDoubleCheck: (v: boolean) => void;
  /** Reproduces the app's original (pre-fix), known-inaccurate checker for comparison. Off by default. */
  legacyChecker: boolean;
  setLegacyChecker: (v: boolean) => void;
  autoClaim: boolean;
  setAutoClaim: (v: boolean) => void;
  // session
  sessionId: string | null;
  snapshot: SessionSnapshot | null;
  isRunning: boolean;
  isPaused: boolean;
  starting: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  togglePause: () => Promise<void>;
  reset: () => void;
  // feed + hits
  feed: ActivityEvent[];
  feedConnected: boolean;
  clearFeed: () => void;
  hits: ActivityEvent[];
  // saved + claim
  saved: string[];
  save: (tag: string) => void;
  unsave: (tag: string) => void;
  exportSaved: () => void;
  claimStatuses: Map<string, ClaimStatus>;
  claimRecords: Map<string, ClaimRecord>;
  claim: (tag: string) => Promise<void>;
  // xbox account
  auth: ReturnType<typeof useXboxAuth>;
  isAuthed: boolean;
  /** Full chain verified server-side: the account can claim. */
  accountReady: boolean;
  connectOpen: boolean;
  setConnectOpen: (open: boolean) => void;
}

const CheckerContext = createContext<CheckerContextValue | null>(null);

export function useChecker(): CheckerContextValue {
  const ctx = useContext(CheckerContext);
  if (!ctx) throw new Error("useChecker must be used inside CheckerProvider");
  return ctx;
}

function readSaved(): string[] {
  try {
    const raw = readStored(SAVED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readParams(): Record<string, Params> {
  const base = defaultParamsByMode();
  try {
    const raw = readStored(PARAMS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (isPlainObject(parsed)) {
      for (const [id, p] of Object.entries(parsed)) {
        if (id in base && isPlainObject(p)) base[id] = { ...base[id], ...p };
      }
    }
  } catch { /* fall back to defaults */ }
  return base;
}

function readTemplates(): TemplateDef[] {
  try {
    const raw = readStored(TEMPLATES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is TemplateDef =>
        isPlainObject(t) && typeof t["id"] === "string" && typeof t["label"] === "string" &&
        typeof t["mode"] === "string" && t["mode"] in MODE_BY_ID && isPlainObject(t["params"]),
    ).slice(0, MAX_SAVED_TEMPLATES);
  } catch {
    return [];
  }
}

export function CheckerProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<string>(() => {
    const stored = readStored(MODE_KEY);
    return stored && stored in MODE_BY_ID ? stored : "letters";
  });
  const [lastRealMode, setLastRealMode] = useState<string>(() => (mode === "templates" ? "letters" : mode));
  const [paramsByMode, setParamsByMode] = useState<Record<string, Params>>(readParams);
  const [savedTemplates, setSavedTemplates] = useState<TemplateDef[]>(readTemplates);
  const [validation, setValidation] = useState<ConfigValidation>({ status: "checking", errors: [], label: "", info: {}, samples: [] });

  const [maxRate, setMaxRate] = useState(DEFAULT_MAX_RATE);
  const [proxyCount, setProxyCount] = useState(0);

  const refreshProxyState = useCallback(async () => {
    try {
      const res = await fetch(api("/xbox/settings/proxies"));
      if (!res.ok) return;
      const d = (await res.json()) as { count?: number; maxRate?: number };
      if (typeof d.maxRate === "number") setMaxRate(d.maxRate);
      if (typeof d.count === "number") setProxyCount(d.count);
    } catch { /* leave previous state */ }
  }, []);

  useEffect(() => { void refreshProxyState(); }, [refreshProxyState]);

  const [rate, setRateState] = useState(() => {
    const n = Number(readStored(RATE_KEY));
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? Math.round(n) : 8;
  });
  const [doubleCheck, setDoubleCheckState] = useState(() => readStored(DOUBLE_CHECK_KEY) === "true");
  const [legacyChecker, setLegacyCheckerState] = useState(() => readStored(LEGACY_CHECKER_KEY) === "true");
  const [autoClaim, setAutoClaimState] = useState(() => readStored(AUTOCLAIM_KEY) === "true");

  const [sessionId, setSessionId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
  });
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const claimsInFlight = useRef(new Set<string>());

  const [saved, setSaved] = useState<string[]>(readSaved);
  // Latest backend claim record per gamertag (upper-cased key).
  const [claimRecords, setClaimRecords] = useState<Map<string, ClaimRecord>>(new Map());
  const [pendingClaims, setPendingClaims] = useState<Set<string>>(new Set());
  const [connectOpen, setConnectOpen] = useState(false);

  const auth = useXboxAuth();
  const isAuthed = auth.status?.authenticated === true;
  const accountReady = auth.status?.account?.ready === true;
  const { events: feed, hits, connected: feedConnected, clear: clearFeed } = useActivityFeed();

  const params = paramsByMode[mode] ?? {};

  const persistSession = useCallback((id: string | null) => {
    setSessionId(id);
    try {
      if (id) sessionStorage.setItem(SESSION_KEY, id);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch { /* storage unavailable */ }
  }, []);

  const handleMissing = useCallback(() => {
    persistSession(null);
    toast.info("The search session ended on the server.");
  }, [persistSession]);
  const { snapshot, refresh } = useSessionSnapshot(sessionId, handleMissing);

  // ── Generation settings ────────────────────────────────────────────────────
  const setMode = useCallback((id: string) => {
    if (!(id in MODE_BY_ID)) return;
    setModeState(id);
    writeStored(MODE_KEY, id);
    if (id !== "templates") setLastRealMode(id);
  }, []);

  const setParams = useCallback((patch: Params) => {
    setParamsByMode((prev) => ({ ...prev, [mode]: { ...prev[mode], ...patch } }));
  }, [mode]);

  useEffect(() => {
    const out: Record<string, Params> = {};
    for (const [id, p] of Object.entries(paramsByMode)) out[id] = persistableParams(id, p);
    writeStored(PARAMS_KEY, JSON.stringify(out));
  }, [paramsByMode]);

  useEffect(() => { writeStored(TEMPLATES_KEY, JSON.stringify(savedTemplates)); }, [savedTemplates]);

  const applyTemplate = useCallback((t: TemplateDef) => {
    const def = MODE_BY_ID[t.mode];
    if (!def) return;
    setParamsByMode((prev) => ({ ...prev, [t.mode]: { ...def.defaults, ...t.params } }));
    setMode(t.mode);
  }, [setMode]);

  const saveTemplate = useCallback((name: string) => {
    if (lastRealMode === "list") {
      toast.error("List settings can't be saved as a template.");
      return;
    }
    const def = MODE_BY_ID[lastRealMode];
    if (!def) return;
    const tpl: TemplateDef = {
      id: `user-${Date.now().toString(36)}`,
      label: name.slice(0, 40),
      hint: def.label,
      mode: lastRealMode,
      params: persistableParams(lastRealMode, paramsByMode[lastRealMode] ?? {}),
    };
    setSavedTemplates((prev) => [tpl, ...prev].slice(0, MAX_SAVED_TEMPLATES));
    toast.success(`Saved template "${tpl.label}"`);
  }, [lastRealMode, paramsByMode]);

  const deleteTemplate = useCallback((id: string) => {
    setSavedTemplates((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // The server is the only authority on whether settings are valid.
  useEffect(() => {
    if (mode === "templates") {
      setValidation({ status: "error", errors: ["Choose a template to continue."], label: "", info: {}, samples: [] });
      return;
    }
    setValidation((v) => ({ ...v, status: "checking" }));
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(api("/gamertag/config/validate"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: { mode, params } }),
          signal: controller.signal,
        });
        const d = (await res.json()) as {
          valid?: boolean; errors?: string[]; label?: string; info?: ConfigValidation["info"]; samples?: string[];
        };
        setValidation({
          status: d.valid === true ? "ok" : "error",
          errors: Array.isArray(d.errors) ? d.errors : [],
          label: d.label ?? "",
          info: d.info ?? {},
          samples: Array.isArray(d.samples) ? d.samples : [],
        });
      } catch {
        if (controller.signal.aborted) return;
        setValidation({ status: "error", errors: ["Could not validate these settings. Is the API reachable?"], label: "", info: {}, samples: [] });
      }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, params]);

  // ── Search settings ────────────────────────────────────────────────────────
  // Not clamped to maxRate: that's an informational ceiling (past it,
  // checks silently fail Xbox's own CDN rate limit more often without
  // proxies spreading the load), not a hard restriction on what the user
  // can choose to try.
  const setRate = useCallback((n: number) => {
    const v = Math.min(1000, Math.max(1, Math.round(n) || 1));
    setRateState(v);
    writeStored(RATE_KEY, String(v));
  }, []);
  const setDoubleCheck = useCallback((v: boolean) => { setDoubleCheckState(v); writeStored(DOUBLE_CHECK_KEY, String(v)); }, []);
  const setLegacyChecker = useCallback((v: boolean) => { setLegacyCheckerState(v); writeStored(LEGACY_CHECKER_KEY, String(v)); }, []);
  const setAutoClaim = useCallback((v: boolean) => { setAutoClaimState(v); writeStored(AUTOCLAIM_KEY, String(v)); }, []);

  // ── Session controls ───────────────────────────────────────────────────────
  const isRunning = sessionId !== null && (snapshot === null || snapshot.state === "running");
  const isPaused = snapshot?.paused === true && isRunning;

  const start = useCallback(async () => {
    // Guard against a double click starting two sessions.
    if (startingRef.current || isRunning) return;
    if (validation.status !== "ok") {
      toast.error(validation.errors[0] ?? "Fix the settings before starting.");
      return;
    }
    if (doubleCheck && !isAuthed) {
      toast.info("Connect Xbox to use Double Check.");
      setConnectOpen(true);
      return;
    }
    if (autoClaim && !accountReady) {
      toast.error(`Auto-claim is on, but the Xbox account can't claim yet: ${auth.status?.account?.reason ?? "connect Xbox first"}`);
      setConnectOpen(true);
      return;
    }
    startingRef.current = true;
    setStarting(true);
    try {
      const body: GamertagSearchInput = {
        config: { mode: mode as GenerationMode, params },
        rate,
        runEthanPolicyCheck: doubleCheck,
        legacyChecker,
        // Auto-claim runs on the server, so it keeps working with this tab closed.
        autoClaim,
      };
      const res = await fetch(api("/gamertag/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        const session = (await res.json()) as GamertagSession;
        persistSession(session.sessionId);
        toast.success("Search started");
      } else {
        const d = (await res.json().catch(() => ({}))) as { error?: string; errors?: string[] };
        toast.error(d.errors?.[0] ?? d.error ?? "Could not start the search.");
      }
    } catch {
      toast.error("Could not start the search. Check that the API is reachable.");
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [isRunning, validation, doubleCheck, legacyChecker, isAuthed, autoClaim, accountReady, auth.status?.account?.reason, mode, params, rate, persistSession]);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(api(`/gamertag/sessions/${encodeURIComponent(sessionId)}`), { method: "DELETE" });
      if (res.ok || res.status === 404) {
        refresh();
        toast.info("Search stopped");
      } else {
        toast.error("The server could not confirm the stop. Try again.");
      }
    } catch {
      toast.error("Could not reach the server to stop the search.");
    }
  }, [sessionId, refresh]);

  const togglePause = useCallback(async () => {
    if (!sessionId) return;
    const action = isPaused ? "resume" : "pause";
    try {
      const res = await fetch(api(`/gamertag/sessions/${encodeURIComponent(sessionId)}/${action}`), { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      refresh(); // the snapshot, not local state, decides what the UI shows
    } catch {
      toast.error(`Could not ${action} the search.`);
    }
  }, [sessionId, isPaused, refresh]);

  const reset = useCallback(() => {
    if (isRunning) return;
    persistSession(null);
    clearFeed();
  }, [isRunning, persistSession, clearFeed]);

  // ── Saved tags ─────────────────────────────────────────────────────────────
  useEffect(() => { writeStored(SAVED_KEY, JSON.stringify(saved)); }, [saved]);
  const save = useCallback((tag: string) => {
    setSaved((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
    toast.success(`Saved ${tag}`);
  }, []);
  const unsave = useCallback((tag: string) => setSaved((prev) => prev.filter((t) => t !== tag)), []);
  const exportSaved = useCallback(() => {
    if (saved.length === 0) return;
    const url = URL.createObjectURL(new Blob([saved.join("\n")], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "saved-gamertags.txt";
    a.click();
    URL.revokeObjectURL(url);
  }, [saved]);

  // ── Claim ──────────────────────────────────────────────────────────────────
  // The backend is the source of truth. Records are polled (they include
  // server-side auto-claims from the Checker and the Sniper) and a manual
  // claim applies its own response immediately.
  const claimCursor = useRef(0);
  const ingestClaims = useCallback((records: ClaimRecord[]) => {
    if (records.length === 0) return;
    // Advance the cursor only past finished records, so an in-flight claim is
    // fetched again until its outcome arrives.
    let blocked = false;
    for (const r of [...records].sort((a, b) => a.id - b.id)) {
      if (r.finishedAt === null) blocked = true;
      else if (!blocked && r.id > claimCursor.current) claimCursor.current = r.id;
    }
    setClaimRecords((prev) => {
      const next = new Map(prev);
      for (const r of records) {
        const key = r.gamertag.toUpperCase();
        const cur = next.get(key);
        if (!cur || cur.id <= r.id) next.set(key, r);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await fetch(api(`/gamertag/claims?after=${claimCursor.current}`));
        if (res.ok) ingestClaims(((await res.json()) as { claims: ClaimRecord[] }).claims);
      } catch { /* retry next tick */ }
      if (!disposed) timer = setTimeout(poll, document.hidden ? 6_000 : 2_000);
    };
    void poll();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [ingestClaims]);

  const claim = useCallback(async (gamertag: string) => {
    if (!isAuthed) {
      toast.error("Connect Xbox to claim gamertags.");
      setConnectOpen(true);
      return;
    }
    if (!accountReady) {
      toast.error(`The Xbox account can't claim yet: ${auth.status?.account?.reason ?? "not verified"}`);
      setConnectOpen(true);
      return;
    }
    const key = gamertag.toUpperCase();
    // Synchronous guard: two rapid clicks can never send two requests.
    if (claimsInFlight.current.has(key)) return;
    claimsInFlight.current.add(key);
    setPendingClaims((prev) => new Set(prev).add(key));
    try {
      const res = await fetch(api("/gamertag/claim"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gamertag }),
      });
      const data = (await res.json()) as { success?: boolean; message?: string; claim?: ClaimRecord };
      if (data.claim) ingestClaims([data.claim]);
      if (data.success === true && data.claim?.state === "claimed") {
        toast.success(`Claimed ${gamertag} — confirmed by Xbox`, { duration: 8000 });
      } else {
        toast.error(data.message ?? `Could not claim ${gamertag}`);
      }
    } catch {
      toast.error(`Network error while claiming ${gamertag}. Check the claim status before retrying.`);
    } finally {
      claimsInFlight.current.delete(key);
      setPendingClaims((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, [isAuthed, accountReady, auth.status?.account?.reason, ingestClaims]);

  const claimStatuses = useMemo(() => {
    const m = new Map<string, ClaimStatus>();
    for (const [key, r] of claimRecords) m.set(key, r.state);
    for (const key of pendingClaims) if (!m.has(key) || m.get(key) !== "claimed") m.set(key, "claiming");
    return m;
  }, [claimRecords, pendingClaims]);

  const value = useMemo<CheckerContextValue>(() => ({
    mode, setMode, params, setParams, validation,
    builtinTemplates: BUILTIN_TEMPLATES, savedTemplates, applyTemplate, saveTemplate, deleteTemplate,
    templateSourceLabel: MODE_BY_ID[lastRealMode]?.label ?? "",
    rate, setRate, maxRate, proxyCount, refreshProxyState, doubleCheck, setDoubleCheck, legacyChecker, setLegacyChecker, autoClaim, setAutoClaim,
    sessionId, snapshot, isRunning, isPaused, starting, start, stop, togglePause, reset,
    feed, feedConnected, clearFeed, hits,
    saved, save, unsave, exportSaved, claimStatuses, claimRecords, claim,
    auth, isAuthed, accountReady, connectOpen, setConnectOpen,
  }), [
    mode, setMode, params, setParams, validation, savedTemplates, applyTemplate, saveTemplate, deleteTemplate, lastRealMode,
    rate, setRate, maxRate, proxyCount, refreshProxyState, doubleCheck, setDoubleCheck, legacyChecker, setLegacyChecker, autoClaim, setAutoClaim,
    sessionId, snapshot, isRunning, isPaused, starting, start, stop, togglePause, reset,
    feed, feedConnected, clearFeed, hits, saved, save, unsave, exportSaved, claimStatuses, claimRecords, claim,
    auth, isAuthed, accountReady, connectOpen,
  ]);

  return <CheckerContext.Provider value={value}>{children}</CheckerContext.Provider>;
}

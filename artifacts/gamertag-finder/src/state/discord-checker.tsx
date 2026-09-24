import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { DiscordSearchInput, DiscordSession, DiscordGenerationMode } from "@workspace/api-client-react";
import { api, readStored, writeStored, type ActivityEvent } from "@/lib/api";
import {
  DISCORD_BUILTIN_TEMPLATES, DISCORD_MODE_BY_ID, discordDefaultParamsByMode, discordPersistableParams,
  type Params, type TemplateDef,
} from "@/lib/discord-modes";
import { useActivityFeed } from "@/hooks/use-activity-feed";
import { useDiscordSessionSnapshot, type DiscordSessionSnapshot } from "@/hooks/use-discord-session-snapshot";

export interface ConfigValidation {
  status: "checking" | "ok" | "error";
  errors: string[];
  label: string;
  /** List mode: number of names, and invalid entries skipped on request. */
  info: { count?: number; skipped?: number };
  /** A handful of example names these settings could produce. */
  samples: string[];
}

const SESSION_KEY = "universal-discord-session";
const RATE_KEY = "universal-discord-rate";
const MODE_KEY = "universal-discord-mode";
const PARAMS_KEY = "universal-discord-params";
const TEMPLATES_KEY = "universal-discord-templates";
const MAX_SAVED_TEMPLATES = 20;
export const DISCORD_MAX_RATE = 50;

interface DiscordCheckerContextValue {
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
  // session
  sessionId: string | null;
  snapshot: DiscordSessionSnapshot | null;
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
}

const DiscordCheckerContext = createContext<DiscordCheckerContextValue | null>(null);

export function useDiscordChecker(): DiscordCheckerContextValue {
  const ctx = useContext(DiscordCheckerContext);
  if (!ctx) throw new Error("useDiscordChecker must be used inside DiscordCheckerProvider");
  return ctx;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readParams(): Record<string, Params> {
  const base = discordDefaultParamsByMode();
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
        typeof t["mode"] === "string" && t["mode"] in DISCORD_MODE_BY_ID && isPlainObject(t["params"]),
    ).slice(0, MAX_SAVED_TEMPLATES);
  } catch {
    return [];
  }
}

export function DiscordCheckerProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<string>(() => {
    const stored = readStored(MODE_KEY);
    return stored && stored in DISCORD_MODE_BY_ID ? stored : "word_num_word";
  });
  const [lastRealMode, setLastRealMode] = useState<string>(() => (mode === "templates" ? "word_num_word" : mode));
  const [paramsByMode, setParamsByMode] = useState<Record<string, Params>>(readParams);
  const [savedTemplates, setSavedTemplates] = useState<TemplateDef[]>(readTemplates);
  const [validation, setValidation] = useState<ConfigValidation>({ status: "checking", errors: [], label: "", info: {}, samples: [] });

  const [rate, setRateState] = useState(() => {
    const n = Number(readStored(RATE_KEY));
    return Number.isFinite(n) && n >= 1 && n <= DISCORD_MAX_RATE ? Math.round(n) : 8;
  });

  const [sessionId, setSessionId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
  });
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);

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
  const { snapshot, refresh } = useDiscordSessionSnapshot(sessionId, handleMissing);

  // ── Generation settings ────────────────────────────────────────────────────
  const setMode = useCallback((id: string) => {
    if (!(id in DISCORD_MODE_BY_ID)) return;
    setModeState(id);
    writeStored(MODE_KEY, id);
    if (id !== "templates") setLastRealMode(id);
  }, []);

  const setParams = useCallback((patch: Params) => {
    setParamsByMode((prev) => ({ ...prev, [mode]: { ...prev[mode], ...patch } }));
  }, [mode]);

  useEffect(() => {
    const out: Record<string, Params> = {};
    for (const [id, p] of Object.entries(paramsByMode)) out[id] = discordPersistableParams(id, p);
    writeStored(PARAMS_KEY, JSON.stringify(out));
  }, [paramsByMode]);

  useEffect(() => { writeStored(TEMPLATES_KEY, JSON.stringify(savedTemplates)); }, [savedTemplates]);

  const applyTemplate = useCallback((t: TemplateDef) => {
    const def = DISCORD_MODE_BY_ID[t.mode];
    if (!def) return;
    setParamsByMode((prev) => ({ ...prev, [t.mode]: { ...def.defaults, ...t.params } }));
    setMode(t.mode);
  }, [setMode]);

  const saveTemplate = useCallback((name: string) => {
    if (lastRealMode === "list") {
      toast.error("List settings can't be saved as a template.");
      return;
    }
    const def = DISCORD_MODE_BY_ID[lastRealMode];
    if (!def) return;
    const tpl: TemplateDef = {
      id: `user-${Date.now().toString(36)}`,
      label: name.slice(0, 40),
      hint: def.label,
      mode: lastRealMode,
      params: discordPersistableParams(lastRealMode, paramsByMode[lastRealMode] ?? {}),
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
        const res = await fetch(api("/discord/config/validate"), {
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
  const setRate = useCallback((n: number) => {
    const v = Math.min(DISCORD_MAX_RATE, Math.max(1, Math.round(n) || 1));
    setRateState(v);
    writeStored(RATE_KEY, String(v));
  }, []);

  // ── Session controls ───────────────────────────────────────────────────────
  const isRunning = sessionId !== null && (snapshot === null || snapshot.state === "running");
  const isPaused = snapshot?.paused === true && isRunning;

  const start = useCallback(async () => {
    if (startingRef.current || isRunning) return;
    if (validation.status !== "ok") {
      toast.error(validation.errors[0] ?? "Fix the settings before starting.");
      return;
    }
    startingRef.current = true;
    setStarting(true);
    try {
      const body: DiscordSearchInput = {
        config: { mode: mode as DiscordGenerationMode, params },
        rate,
      };
      const res = await fetch(api("/discord/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        const session = (await res.json()) as DiscordSession;
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
  }, [isRunning, validation, mode, params, rate, persistSession]);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(api(`/discord/sessions/${encodeURIComponent(sessionId)}`), { method: "DELETE" });
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
      const res = await fetch(api(`/discord/sessions/${encodeURIComponent(sessionId)}/${action}`), { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      refresh();
    } catch {
      toast.error(`Could not ${action} the search.`);
    }
  }, [sessionId, isPaused, refresh]);

  const reset = useCallback(() => {
    if (isRunning) return;
    persistSession(null);
    clearFeed();
  }, [isRunning, persistSession, clearFeed]);

  const value = useMemo<DiscordCheckerContextValue>(() => ({
    mode, setMode, params, setParams, validation,
    builtinTemplates: DISCORD_BUILTIN_TEMPLATES, savedTemplates, applyTemplate, saveTemplate, deleteTemplate,
    templateSourceLabel: DISCORD_MODE_BY_ID[lastRealMode]?.label ?? "",
    rate, setRate,
    sessionId, snapshot, isRunning, isPaused, starting, start, stop, togglePause, reset,
    feed, feedConnected, clearFeed, hits,
  }), [
    mode, setMode, params, setParams, validation, savedTemplates, applyTemplate, saveTemplate, deleteTemplate, lastRealMode,
    rate, setRate,
    sessionId, snapshot, isRunning, isPaused, starting, start, stop, togglePause, reset,
    feed, feedConnected, clearFeed, hits,
  ]);

  return <DiscordCheckerContext.Provider value={value}>{children}</DiscordCheckerContext.Provider>;
}

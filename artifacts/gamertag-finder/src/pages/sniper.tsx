import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Crosshair, Loader2, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Panel, Eyebrow, PageHeader } from "@/components/panel";
import { XboxAccountSummary } from "@/components/xbox-connect";
import { useChecker } from "@/state/checker";
import { useXboxAccounts } from "@/hooks/use-xbox-accounts";
import {
  useSniperTargets,
  type SniperAvailability, type SniperClaim, type SniperConfig, type SniperEvent, type SniperSnapshot, type SniperState,
} from "@/hooks/use-sniper";
import { formatClock, readStored, writeStored } from "@/lib/api";
import { cn } from "@/lib/utils";

const DRAFT_KEY = "universal-xbox-sniper-draft";
const INTERVALS = [500, 1_000, 1_500, 2_000, 3_000, 5_000, 10_000, 30_000, 60_000];

const STATE_LABEL: Record<SniperState, string> = {
  idle: "IDLE",
  watching: "WATCHING",
  claiming: "CLAIMING",
  claimed: "CLAIMED",
  stopped: "STOPPED",
  error: "STOPPED · ERROR",
};

const AVAIL_LABEL: Record<SniperAvailability, string> = {
  unknown: "UNKNOWN",
  taken: "TAKEN",
  available: "AVAILABLE",
  invalid: "NOT ALLOWED",
  rate_limited: "RATE LIMITED",
  network_error: "NETWORK ERROR",
  auth_error: "AUTH ERROR",
};

const CLAIM_LABEL: Record<SniperClaim, string> = {
  waiting: "WAITING",
  disabled: "AUTO CLAIM OFF",
  claiming: "CLAIMING",
  claimed: "CLAIMED",
  claim_failed: "CLAIM FAILED",
  auth_error: "AUTH ERROR",
  rate_limited: "RATE LIMITED",
  network_error: "NETWORK ERROR",
  unknown: "UNKNOWN",
};

const LEVEL_STYLE: Record<SniperEvent["level"], string> = {
  info: "text-muted-foreground",
  check: "text-muted-foreground/60",
  taken: "text-foreground/80",
  available: "font-semibold text-primary",
  claim: "text-primary",
  success: "font-semibold text-primary",
  warn: "text-[hsl(32_55%_38%)]",
  error: "text-destructive",
};

function fmtInterval(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${ms / 1_000} s`;
}

function fmtMs(v: number | null | undefined): string {
  return v === null || v === undefined ? "--" : `${v} ms`;
}

function readDraft(): SniperConfig {
  const base: SniperConfig = { target: "", intervalMs: 1_500, autoClaim: true, notifications: true, doubleCheck: true, accountId: undefined };
  try {
    const raw = readStored(DRAFT_KEY);
    const d = raw ? (JSON.parse(raw) as Partial<SniperConfig>) : {};
    return {
      target: "", // never resume a stale target across reloads
      intervalMs: INTERVALS.includes(Number(d.intervalMs)) ? Number(d.intervalMs) : base.intervalMs,
      autoClaim: typeof d.autoClaim === "boolean" ? d.autoClaim : base.autoClaim,
      notifications: typeof d.notifications === "boolean" ? d.notifications : base.notifications,
      doubleCheck: typeof d.doubleCheck === "boolean" ? d.doubleCheck : base.doubleCheck,
      accountId: typeof d.accountId === "string" ? d.accountId : undefined,
    };
  } catch {
    return base;
  }
}

/** Relative "3s ago" that re-renders once a second. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function ago(ts: number | null, now: number): string {
  if (!ts) return "--";
  const s = Math.max(0, Math.round((now - ts) / 1_000));
  return `${formatClock(ts)} · ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`} ago`;
}

function Tile({ label, children, tone, hint }: { label: string; children: ReactNode; tone?: "gold" | "bad" | "muted"; hint?: string | null }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-3" title={hint ?? undefined}>
      <p className="eyebrow">{label}</p>
      <p
        className={cn(
          "tabular mt-1.5 break-words font-mono text-[15px] font-semibold tracking-wide",
          tone === "gold" && "text-primary",
          tone === "bad" && "text-destructive",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {children}
      </p>
    </div>
  );
}

function Toggle({
  id, title, description, checked, onChange, disabled,
}: {
  id: string; title: string; description: string;
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">{title}</label>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5 shrink-0" />
    </div>
  );
}

const EventRow = memo(function EventRow({ e }: { e: SniperEvent }) {
  return (
    <li className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 border-b border-border/50 px-4 py-1.5 font-mono text-[12.5px] leading-relaxed last:border-b-0 sm:grid-cols-[76px_minmax(0,1fr)]">
      <span className="text-muted-foreground/60">{formatClock(e.ts)}</span>
      <span className={cn("break-words", LEVEL_STYLE[e.level])}>{e.message}</span>
    </li>
  );
});

function LiveActivity({ events, streamConnected }: { events: SniperEvent[]; streamConnected: boolean }) {
  const [hideChecks, setHideChecks] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const stick = useRef(true);
  const rows = useMemo(() => (hideChecks ? events.filter((e) => e.level !== "check") : events).slice(-200), [events, hideChecks]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="eyebrow">Live activity</span>
          <span
            className={cn("h-1.5 w-1.5 rounded-full", streamConnected ? "bg-primary" : "bg-muted-foreground/50")}
            title={streamConnected ? "Realtime stream connected" : "Realtime stream offline — polling the server"}
          />
          <span className="font-mono text-[11px] text-muted-foreground">{streamConnected ? "LIVE" : "POLLING"}</span>
        </div>
        <button
          type="button"
          onClick={() => setHideChecks((v) => !v)}
          className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {hideChecks ? "SHOW CHECKS" : "HIDE CHECKS"}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ul
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="max-h-[320px] overflow-y-auto py-1"
          aria-live="polite"
        >
          {rows.map((e) => <EventRow key={e.seq} e={e} />)}
        </ul>
      )}
    </div>
  );
}

function TargetCard({
  s, events, now, busy, streamConnected, onStop, onRemove, onUpdateSettings,
}: {
  s: SniperSnapshot;
  events: SniperEvent[];
  now: number;
  busy: boolean;
  streamConnected: boolean;
  onStop: () => void;
  onRemove: () => void;
  onUpdateSettings: (patch: Partial<Pick<SniperConfig, "autoClaim" | "notifications">>) => void;
}) {
  const [expanded, setExpanded] = useState(s.state === "watching" || s.state === "claiming");
  const running = s.state === "watching" || s.state === "claiming";
  const availTone = s.availability === "available" ? "gold" : ["auth_error", "invalid", "network_error", "rate_limited"].includes(s.availability) ? "bad" : undefined;
  const claimTone = s.claim === "claimed" || s.claim === "claiming" ? "gold" : ["claim_failed", "auth_error", "unknown", "network_error", "rate_limited"].includes(s.claim) ? "bad" : "muted";

  return (
    <Panel className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex min-w-0 items-center gap-3 text-left">
          <span
            className={cn("h-2 w-2 shrink-0 rounded-full", running ? "animate-pulse bg-primary" : s.state === "claimed" ? "bg-primary" : s.state === "error" ? "bg-destructive" : "bg-muted-foreground/50")}
          />
          <span className="min-w-0 truncate font-mono text-lg font-semibold tracking-wide">{s.config.target}</span>
          <span
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[11px] tracking-[0.1em]",
              running ? "border-primary/50 text-primary" : s.state === "claimed" ? "border-primary text-primary" : s.state === "error" ? "border-destructive/60 text-destructive" : "border-border text-muted-foreground",
            )}
          >
            {STATE_LABEL[s.state]}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {running && (
            <button
              type="button"
              onClick={onStop}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs tracking-wide transition-colors hover:bg-secondary disabled:opacity-40"
            >
              <Square className="h-3.5 w-3.5" />
              STOP
            </button>
          )}
          {!running && (
            <button
              type="button"
              onClick={onRemove}
              disabled={busy}
              title="Remove"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs tracking-wide text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              REMOVE
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-5 py-4">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            <Tile label="Availability" tone={availTone} hint={s.availabilityDetail}>{AVAIL_LABEL[s.availability]}</Tile>
            <Tile label="Claim" tone={claimTone} hint={s.claimReason}>{CLAIM_LABEL[s.claim]}</Tile>
            <Tile label="Attempts">
              {s.checks.toLocaleString()}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">checks · {s.claimAttempts} claim</span>
            </Tile>
            <Tile label="Last check" tone="muted">{ago(s.lastCheckAt, now)}</Tile>
            <Tile label="Last claim" tone="muted">{ago(s.lastClaimAt, now)}</Tile>
            <Tile label="Latency · check" hint="Last availability check (CDN + Double Check), request start to result">
              {fmtMs(s.latency.availabilityMs)}
              {s.latency.avgAvailabilityMs !== null && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">avg {s.latency.avgAvailabilityMs}</span>
              )}
            </Tile>
            <Tile label="Latency · claim" hint="Reaction = available → claim sent; claim = reserve + change; total = check start → Xbox's answer">
              {fmtMs(s.latency.claimMs)}
              {s.latency.totalMs !== null && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  react {s.latency.reactionMs ?? "-"} · total {s.latency.totalMs}
                </span>
              )}
            </Tile>
          </div>

          <div className="mt-3.5 border-t border-border pt-3.5">
            <Toggle
              id={`autoclaim-${s.id}`}
              title="Auto Claim"
              description="Claim the moment availability is confirmed."
              checked={s.config.autoClaim}
              disabled={!running}
              onChange={(v) => onUpdateSettings({ autoClaim: v })}
            />
            <Toggle
              id={`notify-${s.id}`}
              title="Notifications"
              description="Discord webhook and in-page alerts for this target's claim results."
              checked={s.config.notifications}
              disabled={!running}
              onChange={(v) => onUpdateSettings({ notifications: v })}
            />
          </div>

          {(s.stopReason || s.claimReason || (s.backoffUntil && s.backoffUntil > now)) && (
            <div className="mt-3.5 space-y-1.5 border-t border-border pt-3.5 text-[13px] leading-relaxed">
              {s.backoffUntil && s.backoffUntil > now && (
                <p className="text-[hsl(32_55%_38%)]">Rate limited by Xbox — next check in {Math.ceil((s.backoffUntil - now) / 1000)}s.</p>
              )}
              {s.claimReason && s.claim !== "disabled" && <p className="text-muted-foreground"><span className="eyebrow mr-2">Claim</span>{s.claimReason}</p>}
              {s.stopReason && !running && <p className="text-muted-foreground"><span className="eyebrow mr-2">Stopped</span>{s.stopReason}</p>}
            </div>
          )}

          {s.lastClaim && (
            <details className="mt-3.5 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-3 text-[13px]">
              <summary className="cursor-pointer font-mono text-xs tracking-wide text-muted-foreground">LAST CLAIM · XBOX RESPONSE</summary>
              <dl className="mt-3 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 font-mono text-xs">
                <dt className="text-muted-foreground">Result</dt><dd>{s.lastClaim.state.toUpperCase()}</dd>
                <dt className="text-muted-foreground">Confirmed by</dt><dd>{s.lastClaim.confirmedBy === "change_response" ? "Xbox change response" : s.lastClaim.confirmedBy === "xsts_identity" ? "Xbox account identity (XSTS)" : "—"}</dd>
                <dt className="text-muted-foreground">Step / HTTP</dt><dd>{s.lastClaim.step ?? "—"} / {s.lastClaim.httpStatus ?? "—"}</dd>
                <dt className="text-muted-foreground">Timing</dt>
                <dd>reserve {fmtMs(s.lastClaim.latency.reserveMs)} · change {fmtMs(s.lastClaim.latency.changeMs)} · total {fmtMs(s.lastClaim.latency.totalMs)}</dd>
                {s.lastClaim.xboxResponse && (<><dt className="text-muted-foreground">Body</dt><dd className="break-all">{s.lastClaim.xboxResponse}</dd></>)}
              </dl>
            </details>
          )}

          <div className="mt-3.5">
            <LiveActivity events={events} streamConnected={streamConnected} />
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function SniperPage() {
  const c = useChecker();
  const { targets, eventsById, limits, streamConnected, reachable, startTarget, stopTarget, removeTarget, updateTargetSettings } = useSniperTargets();
  const { accounts } = useXboxAccounts();
  const [draft, setDraft] = useState<SniperConfig>(readDraft);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const lastNotifiedSeq = useRef<Map<string, number>>(new Map());
  const now = useNow(true);

  const account = targets[0]?.account ?? c.auth.status?.account;
  const activeCount = targets.filter((t) => t.state === "watching" || t.state === "claiming").length;

  useEffect(() => {
    writeStored(DRAFT_KEY, JSON.stringify(draft));
  }, [draft]);

  // A toast per new claim outcome, once, only for events this tab saw live.
  useEffect(() => {
    for (const t of targets) {
      const events = eventsById.get(t.id) ?? [];
      const last = lastNotifiedSeq.current.get(t.id);
      if (last === undefined) {
        if (events.length > 0) lastNotifiedSeq.current.set(t.id, events[events.length - 1]!.seq);
        continue;
      }
      let newest = last;
      for (const e of events) {
        if (e.seq <= last) continue;
        newest = Math.max(newest, e.seq);
        if (!t.config.notifications) continue;
        if (e.level === "success") toast.success(e.message, { duration: 12_000 });
        else if (e.level === "error") toast.error(e.message, { duration: 8_000 });
      }
      lastNotifiedSeq.current.set(t.id, newest);
    }
  }, [targets, eventsById]);

  const setField = <K extends keyof SniperConfig>(k: K, v: SniperConfig[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const onStart = async () => {
    if (starting) return;
    const target = draft.target.trim();
    if (!target) { toast.error("Enter a target gamertag."); return; }
    if ((draft.autoClaim || draft.doubleCheck) && !account?.ready) {
      toast.error(`Xbox account not ready: ${account?.reason ?? "connect Xbox first"}`);
      c.setConnectOpen(true);
      return;
    }
    if (activeCount >= limits.maxTargets) {
      toast.error(`Cannot watch more than ${limits.maxTargets} targets at once. Stop another target first.`);
      return;
    }
    setStarting(true);
    const r = await startTarget({ ...draft, target });
    setStarting(false);
    if (!r.ok) { toast.error(r.error ?? "Could not start the sniper."); return; }
    setField("target", "");
    toast.success(`Watching ${target}`);
  };

  return (
    <>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Xbox</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Sniper</h1>
        </div>
        <span
          role="status"
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs tracking-[0.14em]",
            activeCount > 0 ? "border-primary/50 text-primary" : "border-border text-muted-foreground",
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", activeCount > 0 ? "animate-pulse bg-primary" : "bg-muted-foreground/50")} />
          {activeCount > 0 ? `${activeCount} / ${limits.maxTargets} WATCHING` : "IDLE"}
        </span>
      </header>

      {!reachable && (
        <p role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-4 py-3 text-sm">
          Can't reach the server right now. Any targets already watching keep running on the server; this page will catch up when the connection returns.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Panel>
          <Eyebrow>Add target</Eyebrow>
          <label htmlFor="sniper-target" className="sr-only">Target gamertag</label>
          <input
            id="sniper-target"
            value={draft.target}
            maxLength={15}
            spellCheck={false}
            autoComplete="off"
            placeholder="example"
            onChange={(e) => setField("target", e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void onStart(); }}
            className="mt-3 w-full rounded-lg border border-input bg-[hsl(var(--well))] px-4 py-3 font-mono text-xl font-semibold tracking-wide text-foreground placeholder:text-muted-foreground/40 focus:border-primary/60 focus:outline-none"
          />

          <div className="mt-5">
            <p className="text-sm font-medium">Check interval</p>
            <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Check interval">
              {INTERVALS.map((ms) => (
                <button
                  key={ms}
                  type="button"
                  role="radio"
                  aria-checked={draft.intervalMs === ms}
                  onClick={() => setField("intervalMs", ms)}
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors",
                    draft.intervalMs === ms
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {fmtInterval(ms)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              One check per interval, per target. Xbox rate limits (HTTP 429) are honoured automatically.
            </p>
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <Toggle
              id="sniper-autoclaim"
              title="Auto Claim"
              description="Claim the gamertag for the connected account the moment it is confirmed available. Only an Xbox-confirmed claim counts."
              checked={draft.autoClaim}
              onChange={(v) => setField("autoClaim", v)}
            />
            {draft.autoClaim && (
              <div className="py-3.5">
                <label htmlFor="sniper-account" className="text-sm font-medium">Claim account</label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Automatic picks any connected account that's ready and not already claiming.
                </p>
                <select
                  id="sniper-account"
                  value={draft.accountId ?? "automatic"}
                  onChange={(e) => setField("accountId", e.target.value === "automatic" ? undefined : e.target.value)}
                  className="mt-2 w-full rounded-lg border border-input bg-[hsl(var(--well))] px-3 py-2 text-sm"
                >
                  <option value="automatic">Automatic</option>
                  {accounts?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.gamertag ?? a.maskedEmail ?? a.id} {a.readiness.ready ? "" : "(not ready)"}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <Toggle
              id="sniper-doublecheck"
              title="Double Check"
              description="Confirm availability with Xbox's policy check before claiming (same as the Checker)."
              checked={draft.doubleCheck}
              onChange={(v) => setField("doubleCheck", v)}
            />
            <Toggle
              id="sniper-notify"
              title="Notifications"
              description="Discord webhook (set in Settings) and in-page alerts for claim results."
              checked={draft.notifications}
              onChange={(v) => setField("notifications", v)}
            />
          </div>

          <div className="mt-5 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => void onStart()}
              disabled={starting || activeCount >= limits.maxTargets}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold tracking-wide text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crosshair className="h-4 w-4" />}
              WATCH TARGET
            </button>
          </div>
          {activeCount >= limits.maxTargets && (
            <p className="mt-2.5 text-xs text-muted-foreground">
              Watching the maximum of {limits.maxTargets} targets at once. Stop one to add another.
            </p>
          )}
        </Panel>

        <Panel>
          <Eyebrow>Xbox account</Eyebrow>
          <div className="mt-4">
            {account && account.connected ? (
              <XboxAccountSummary account={account} />
            ) : (
              <div className="space-y-4">
                <p className="flex items-center gap-2 text-sm font-semibold tracking-wide">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-muted-foreground/50" />
                  NOT CONNECTED
                </p>
                {account?.reason && account.code === "invalid_grant" && (
                  <p className="text-[13px] text-muted-foreground">{account.reason}</p>
                )}
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  Sign in with Microsoft's own page. The app never sees your password, and tokens stay on the server.
                </p>
              </div>
            )}
            <button
              type="button"
              onClick={() => c.setConnectOpen(true)}
              className="mt-4 w-full rounded-lg border border-primary/50 py-2.5 text-sm font-medium tracking-wide text-primary transition-colors hover:bg-primary/10"
            >
              {account?.connected ? "MANAGE XBOX" : "CONNECT XBOX"}
            </button>
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <PageHeader title={`Targets${targets.length ? ` (${targets.length})` : ""}`} />
        {targets.length === 0 ? (
          <Panel>
            <p className="py-8 text-center text-sm text-muted-foreground">No targets yet. Add one above to start watching.</p>
          </Panel>
        ) : (
          <div className="space-y-3">
            {targets.map((t) => (
              <TargetCard
                key={t.id}
                s={t}
                events={eventsById.get(t.id) ?? []}
                now={now}
                busy={busyId === t.id}
                streamConnected={streamConnected}
                onStop={async () => {
                  setBusyId(t.id);
                  const ok = await stopTarget(t.id);
                  setBusyId(null);
                  if (!ok) toast.error("The server did not confirm the stop. Try again.");
                }}
                onRemove={async () => {
                  setBusyId(t.id);
                  const ok = await removeTarget(t.id);
                  setBusyId(null);
                  if (!ok) toast.error("Could not remove this target. Try again.");
                }}
                onUpdateSettings={(patch) => void updateTargetSettings(t.id, patch)}
              />
            ))}
          </div>
        )}
      </div>

      {!streamConnected && targets.length > 0 && (
        <p className="mt-3 text-center text-xs text-muted-foreground">Realtime stream offline — polling the server.</p>
      )}
    </>
  );
}

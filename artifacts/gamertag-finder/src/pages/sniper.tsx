import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Crosshair, Loader2, Square } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Panel, Eyebrow } from "@/components/panel";
import { XboxAccountSummary } from "@/components/xbox-connect";
import { useChecker } from "@/state/checker";
import {
  useSniper,
  type SniperAvailability, type SniperClaim, type SniperConfig, type SniperEvent, type SniperState,
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
  warn: "text-[hsl(38_80%_60%)]",
  error: "text-destructive",
};

function fmtInterval(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${ms / 1_000} s`;
}

function fmtMs(v: number | null | undefined): string {
  return v === null || v === undefined ? "--" : `${v} ms`;
}

function readDraft(): SniperConfig {
  const base: SniperConfig = { target: "", intervalMs: 1_500, autoClaim: true, notifications: true, doubleCheck: true };
  try {
    const raw = readStored(DRAFT_KEY);
    const d = raw ? (JSON.parse(raw) as Partial<SniperConfig>) : {};
    return {
      target: typeof d.target === "string" ? d.target : base.target,
      intervalMs: INTERVALS.includes(Number(d.intervalMs)) ? Number(d.intervalMs) : base.intervalMs,
      autoClaim: typeof d.autoClaim === "boolean" ? d.autoClaim : base.autoClaim,
      notifications: typeof d.notifications === "boolean" ? d.notifications : base.notifications,
      doubleCheck: typeof d.doubleCheck === "boolean" ? d.doubleCheck : base.doubleCheck,
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

  // Follow new entries unless the user scrolled up to read.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  return (
    <Panel className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <Eyebrow>Live activity</Eyebrow>
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
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">No activity yet. Start the sniper to see real checks here.</p>
      ) : (
        <ul
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="max-h-[420px] overflow-y-auto py-1"
          aria-live="polite"
        >
          {rows.map((e) => <EventRow key={e.seq} e={e} />)}
        </ul>
      )}
    </Panel>
  );
}

export default function SniperPage() {
  const c = useChecker();
  const { snapshot: s, events, streamConnected, reachable, start, stop, updateSettings } = useSniper();
  const [draft, setDraft] = useState<SniperConfig>(readDraft);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const lastNotifiedSeq = useRef<number | null>(null);

  const running = s?.state === "watching" || s?.state === "claiming";
  const account = s?.account ?? c.auth.status?.account;
  const now = useNow(true);

  // While a run is active the form shows the run's own settings.
  const shown: SniperConfig = running && s ? s.config : draft;
  useEffect(() => { writeStored(DRAFT_KEY, JSON.stringify(draft)); }, [draft]);

  // A toast for a claim outcome, once, only for events this tab saw live.
  useEffect(() => {
    if (lastNotifiedSeq.current === null) {
      if (events.length > 0) lastNotifiedSeq.current = events[events.length - 1]!.seq;
      return;
    }
    for (const e of events) {
      if (e.seq <= lastNotifiedSeq.current) continue;
      lastNotifiedSeq.current = e.seq;
      if (!shown.notifications) continue;
      if (e.level === "success") toast.success(e.message, { duration: 12_000 });
      else if (e.level === "error") toast.error(e.message, { duration: 8_000 });
    }
  }, [events, shown.notifications]);

  const setField = <K extends keyof SniperConfig>(k: K, v: SniperConfig[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const onStart = async () => {
    if (busy) return;
    const target = draft.target.trim();
    if (!target) { toast.error("Enter a target gamertag."); return; }
    if ((draft.autoClaim || draft.doubleCheck) && !account?.ready) {
      toast.error(`Xbox account not ready: ${account?.reason ?? "connect Xbox first"}`);
      c.setConnectOpen(true);
      return;
    }
    setBusy("start");
    const r = await start({ ...draft, target });
    setBusy(null);
    if (!r.ok) toast.error(r.error ?? "Could not start the sniper.");
  };

  const onStop = async () => {
    if (busy) return;
    setBusy("stop");
    const ok = await stop();
    setBusy(null);
    if (!ok) toast.error("The server did not confirm the stop. Try again.");
  };

  const availTone = s?.availability === "available" ? "gold" : s && ["auth_error", "invalid", "network_error", "rate_limited"].includes(s.availability) ? "bad" : undefined;
  const claimTone = s?.claim === "claimed" || s?.claim === "claiming" ? "gold" : s && ["claim_failed", "auth_error", "unknown", "network_error", "rate_limited"].includes(s.claim) ? "bad" : "muted";

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
            running ? "border-primary/50 text-primary" : s?.state === "claimed" ? "border-primary text-primary" : s?.state === "error" ? "border-destructive/60 text-destructive" : "border-border text-muted-foreground",
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", running ? "animate-pulse bg-primary" : s?.state === "claimed" ? "bg-primary" : s?.state === "error" ? "bg-destructive" : "bg-muted-foreground/50")} />
          {s ? STATE_LABEL[s.state] : "…"}
        </span>
      </header>

      {!reachable && (
        <p role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-4 py-3 text-sm">
          Can't reach the server right now. The sniper keeps running on the server; this page will catch up when the connection returns.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Panel>
          <Eyebrow>Target</Eyebrow>
          <label htmlFor="sniper-target" className="sr-only">Target gamertag</label>
          <input
            id="sniper-target"
            value={shown.target}
            disabled={running}
            maxLength={15}
            spellCheck={false}
            autoComplete="off"
            placeholder="example"
            onChange={(e) => setField("target", e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !running) void onStart(); }}
            className="mt-3 w-full rounded-lg border border-input bg-[hsl(var(--well))] px-4 py-3 font-mono text-xl font-semibold tracking-wide text-foreground placeholder:text-muted-foreground/40 focus:border-primary/60 focus:outline-none disabled:opacity-70"
          />

          <div className="mt-5">
            <p className="text-sm font-medium">Check interval</p>
            <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Check interval">
              {INTERVALS.map((ms) => (
                <button
                  key={ms}
                  type="button"
                  role="radio"
                  aria-checked={shown.intervalMs === ms}
                  disabled={running}
                  onClick={() => setField("intervalMs", ms)}
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors disabled:cursor-default",
                    shown.intervalMs === ms
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground",
                  )}
                >
                  {fmtInterval(ms)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              One check per interval. Xbox rate limits (HTTP 429) are honoured automatically.
            </p>
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <Toggle
              id="sniper-autoclaim"
              title="Auto Claim"
              description="Claim the gamertag for the connected account the moment it is confirmed available. Only an Xbox-confirmed claim counts."
              checked={shown.autoClaim}
              onChange={(v) => { if (running) void updateSettings({ autoClaim: v }); else setField("autoClaim", v); }}
            />
            <Toggle
              id="sniper-doublecheck"
              title="Double Check"
              description="Confirm availability with Xbox's policy check before claiming (same as the Checker)."
              checked={shown.doubleCheck}
              disabled={running}
              onChange={(v) => setField("doubleCheck", v)}
            />
            <Toggle
              id="sniper-notify"
              title="Notifications"
              description="Discord webhook (set in Settings) and in-page alerts for claim results."
              checked={shown.notifications}
              onChange={(v) => { if (running) void updateSettings({ notifications: v }); else setField("notifications", v); }}
            />
          </div>

          <div className="mt-5 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => void onStart()}
              disabled={running || busy !== null}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold tracking-wide text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crosshair className="h-4 w-4" />}
              START SNIPER
            </button>
            <button
              type="button"
              onClick={() => void onStop()}
              disabled={!running || busy !== null}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm tracking-wide transition-colors hover:bg-secondary disabled:opacity-40"
            >
              <Square className="h-4 w-4" />
              STOP
            </button>
          </div>
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

      <Panel className="mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Eyebrow>Status</Eyebrow>
          {s?.config.target && (
            <span className="font-mono text-sm font-semibold tracking-wide text-foreground">{s.config.target}</span>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          <Tile label="Check status" tone={running ? "gold" : s?.state === "error" ? "bad" : "muted"} hint={s?.stopReason}>
            {s ? STATE_LABEL[s.state] : "--"}
          </Tile>
          <Tile label="Availability" tone={availTone} hint={s?.availabilityDetail}>
            {s ? AVAIL_LABEL[s.availability] : "--"}
          </Tile>
          <Tile label="Claim" tone={claimTone} hint={s?.claimReason}>
            {s ? CLAIM_LABEL[s.claim] : "--"}
          </Tile>
          <Tile label="Attempts">
            {(s?.checks ?? 0).toLocaleString()}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">checks · {s?.claimAttempts ?? 0} claim</span>
          </Tile>
          <Tile label="Last check" tone="muted">{ago(s?.lastCheckAt ?? null, now)}</Tile>
          <Tile label="Last claim" tone="muted">{ago(s?.lastClaimAt ?? null, now)}</Tile>
          <Tile label="Latency · check" hint="Last availability check (CDN + Double Check), request start to result">
            {fmtMs(s?.latency.availabilityMs)}
            {s?.latency.avgAvailabilityMs !== null && s?.latency.avgAvailabilityMs !== undefined && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">avg {s.latency.avgAvailabilityMs}</span>
            )}
          </Tile>
          <Tile label="Latency · claim" hint="Reaction = available → claim sent; claim = reserve + change; total = check start → Xbox's answer">
            {fmtMs(s?.latency.claimMs)}
            {s?.latency.totalMs !== null && s?.latency.totalMs !== undefined && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                react {s.latency.reactionMs ?? "-"} · total {s.latency.totalMs}
              </span>
            )}
          </Tile>
        </div>

        {(s?.stopReason || s?.claimReason || (s?.backoffUntil && s.backoffUntil > now)) && (
          <div className="mt-3 space-y-1.5 text-[13px] leading-relaxed">
            {s?.backoffUntil && s.backoffUntil > now && (
              <p className="text-[hsl(38_80%_60%)]">Rate limited by Xbox — next check in {Math.ceil((s.backoffUntil - now) / 1000)}s.</p>
            )}
            {s?.claimReason && s.claim !== "disabled" && <p className="text-muted-foreground"><span className="eyebrow mr-2">Claim</span>{s.claimReason}</p>}
            {s?.stopReason && !running && <p className="text-muted-foreground"><span className="eyebrow mr-2">Stopped</span>{s.stopReason}</p>}
          </div>
        )}

        {s?.lastClaim && (
          <details className="mt-3 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-3 text-[13px]">
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
      </Panel>

      <div className="mt-4">
        <LiveActivity events={events} streamConnected={streamConnected} />
      </div>
    </>
  );
}

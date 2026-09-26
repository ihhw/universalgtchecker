import type { CSSProperties } from "react";
import { Link } from "wouter";
import { Pause, Play, Square, Zap } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Panel, Eyebrow, PageHeader } from "@/components/panel";
import { ActivityFeed } from "@/components/activity-feed";
import { ModeForm, ModePicker, TemplatesPanel } from "@/components/mode-form";
import { useChecker, type ConfigValidation } from "@/state/checker";
import { useXboxAccounts } from "@/hooks/use-xbox-accounts";
import { MODE_BY_ID } from "@/lib/modes";
import { cn } from "@/lib/utils";

/**
 * A hit's exact-name verification is throttled per Xbox account (Xbox
 * itself only allows so many of these checks per account per second), and
 * that work spreads across every connected account instead of piling up
 * on one. With a single account, verification can lag well behind a fast
 * or large search; connecting more accounts is the only way to raise that
 * ceiling.
 */
function VerificationThroughputHint() {
  const { accounts } = useXboxAccounts();
  const { setConnectOpen } = useChecker();
  if (accounts === null) return null;
  const readyCount = accounts.filter((a) => a.readiness.ready).length;
  if (readyCount === 0) return null;
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-border bg-[hsl(var(--well))] px-3.5 py-2.5">
      <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {readyCount === 1
          ? "1 Xbox account is verifying hits. Verification is throttled per account, so it can lag behind a fast or large search."
          : `${readyCount} Xbox accounts are verifying hits in parallel, so confirmations keep up better with a fast or large search.`}
        {" "}
        <button type="button" onClick={() => setConnectOpen(true)} className="font-medium text-primary underline underline-offset-2 hover:opacity-80">
          {readyCount === 1 ? "Connect more accounts to speed this up" : "Manage accounts"}
        </button>
      </p>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className={cn("tabular mt-1.5 text-2xl font-semibold", accent && "text-primary")}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function Option({
  id, title, description, checked, onChange, disabled,
}: {
  id: string; title: string; description: string;
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">{title}</label>
        <p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5 shrink-0" />
    </div>
  );
}

/** Validation comes from the server; the UI only displays it. */
function ConfigStatus({ v }: { v: ConfigValidation }) {
  if (v.status === "checking") {
    return <p className="mt-3 text-xs text-muted-foreground" role="status">Checking settings…</p>;
  }
  if (v.status === "error") {
    const shown = v.errors.slice(0, 6);
    return (
      <div role="alert" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3.5 py-3">
        <ul className="space-y-1 text-[13px]">
          {shown.map((e) => <li key={e}>{e}</li>)}
        </ul>
        {v.errors.length > shown.length && (
          <p className="mt-1.5 text-xs text-muted-foreground">+{v.errors.length - shown.length} more</p>
        )}
      </div>
    );
  }
  return (
    <div className="mt-3">
      <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-primary" />
        Ready
        {v.info.count !== undefined && ` · ${v.info.count.toLocaleString()} ${v.info.count === 1 ? "name" : "names"}`}
        {v.info.skipped ? ` · ${v.info.skipped.toLocaleString()} invalid skipped` : ""}
      </p>
      {v.samples.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {v.samples.map((s) => (
            <span
              key={s}
              className="rounded-md border border-border bg-[hsl(var(--well))] px-2 py-1 font-mono text-[11px] tracking-wide text-foreground"
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function XboxPage() {
  const c = useChecker();
  const s = c.snapshot;
  const fill = ((c.rate - 1) / 999) * 100;
  const def = MODE_BY_ID[c.mode]!;
  const canStart = c.validation.status === "ok";

  return (
    <>
      <PageHeader title="Xbox" />

      <div className="space-y-4">
        <Panel>
          <Eyebrow>Mode</Eyebrow>
          <div className="mt-4">
            <ModePicker mode={c.mode} onSelect={c.setMode} disabled={c.isRunning} />
          </div>

          {c.mode === "templates" ? (
            <TemplatesPanel
              builtin={c.builtinTemplates}
              saved={c.savedTemplates}
              onApply={c.applyTemplate}
              onSave={c.saveTemplate}
              onDelete={c.deleteTemplate}
              saveLabel={c.templateSourceLabel}
              disabled={c.isRunning}
            />
          ) : (
            <>
              <ModeForm mode={def} params={c.params} onChange={c.setParams} disabled={c.isRunning} />
              <ConfigStatus v={c.validation} />
            </>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            {c.isRunning ? (
              <>
                <button
                  type="button"
                  onClick={() => void c.togglePause()}
                  className="inline-flex items-center gap-2 rounded-lg border border-primary/50 px-5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
                >
                  {c.isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                  {c.isPaused ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  onClick={() => void c.stop()}
                  className="inline-flex items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm transition-colors hover:bg-secondary"
                >
                  <Square className="h-4 w-4" />
                  Stop
                </button>
                <span className="tabular ml-1 font-mono text-xs text-muted-foreground" role="status">
                  {c.isPaused ? "Paused" : `Running · ${s?.cps ?? 0}/s`}
                </span>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void c.start()}
                  disabled={c.starting || !canStart}
                  className="rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {c.starting ? "Starting…" : "Start"}
                </button>
                <button
                  type="button"
                  onClick={c.reset}
                  className="rounded-lg border border-border px-5 py-2.5 text-sm transition-colors hover:bg-secondary"
                >
                  Reset
                </button>
                {s?.state === "completed" && (
                  <span className="font-mono text-xs text-muted-foreground" role="status">Completed</span>
                )}
              </>
            )}
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <div className="flex items-center justify-between">
              <label htmlFor="rate" className="text-sm font-medium">Rate</label>
              <span className="tabular font-mono text-sm text-primary">{c.rate}/s</span>
            </div>
            <input
              id="rate"
              type="range"
              min={1}
              max={1000}
              step={1}
              value={c.rate}
              disabled={c.isRunning}
              onChange={(e) => c.setRate(Number(e.target.value))}
              style={{ "--fill": `${fill}%` } as CSSProperties}
              className="range mt-2"
            />
            {c.proxyCount === 0 && c.rate > c.maxRate && (
              <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                Above {c.maxRate}/s, Xbox's CDN rate-limits a single IP — expect more checks to come back
                "unknown" instead of a real answer at this rate.{" "}
                <Link href="/settings" className="font-medium text-primary underline underline-offset-2 hover:opacity-80">
                  Add proxies in Settings
                </Link>{" "}
                to raise the reliable ceiling.
              </p>
            )}

            <div className="mt-4 divide-y divide-border/60">
              <Option
                id="double-check"
                title="Double Check"
                description="Adds an extra content-policy check before a hit is shown. Off by default: it doesn't know about suffixes (that's confirmed separately either way) and can reject names for reasons unrelated to availability."
                checked={c.doubleCheck}
                onChange={(v) => {
                  if (v && !c.isAuthed) { c.setConnectOpen(true); return; }
                  c.setDoubleCheck(v);
                }}
                disabled={c.isRunning}
              />
              <Option
                id="legacy-checker"
                title="Old checker"
                description="Reproduces the app's original suffix-confirmation logic for comparison — no retry on a network hiccup, no retry on a collision, and a suffix parser later found to misreport most genuine hits as needing a suffix. Off (default) uses the current, accurate checker. Leave this off unless you specifically want to compare against the old behavior."
                checked={c.legacyChecker}
                onChange={c.setLegacyChecker}
                disabled={c.isRunning}
              />
              <Option
                id="auto-claim"
                title="Auto Claim"
                description={
                  c.autoClaim && c.isAuthed && !c.accountReady
                    ? `The connected Xbox account can't claim yet: ${c.auth.status?.account?.reason ?? "not verified"}`
                    : "The server claims the first confirmed hit for the connected Xbox account, even with this tab closed. Only an Xbox-confirmed claim is shown as Claimed."
                }
                checked={c.autoClaim && c.isAuthed}
                onChange={(v) => {
                  if (v && !c.isAuthed) { c.setConnectOpen(true); return; }
                  c.setAutoClaim(v);
                }}
                disabled={c.isRunning}
              />
            </div>
            {c.isAuthed && <VerificationThroughputHint />}
          </div>
        </Panel>

        <Panel>
          <Eyebrow>Progress</Eyebrow>
          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Checked" value={s?.attempts ?? 0} />
            <Stat label="Available" value={s?.found ?? 0} accent />
            <Stat label="Taken" value={s?.taken ?? 0} />
            <Stat label="Unknown" value={s?.unknown ?? 0} />
            <Stat label="Saved" value={c.saved.length} />
          </div>
        </Panel>

        <ActivityFeed
          title="Live feed"
          events={c.feed}
          connected={c.feedConnected}
          onClear={c.clearFeed}
          platform="xbox"
        />
      </div>
    </>
  );
}

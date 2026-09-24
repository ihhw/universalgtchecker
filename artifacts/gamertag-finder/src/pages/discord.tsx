import type { CSSProperties } from "react";
import { Pause, Play, Square } from "lucide-react";
import { Panel, Eyebrow, PageHeader } from "@/components/panel";
import { ActivityFeed } from "@/components/activity-feed";
import { ModeForm, ModePicker, TemplatesPanel } from "@/components/mode-form";
import { useDiscordChecker, DISCORD_MAX_RATE, type ConfigValidation } from "@/state/discord-checker";
import { DISCORD_MODE_BY_ID, DISCORD_LENGTH_MIN, DISCORD_LENGTH_MAX } from "@/lib/discord-modes";
import { cn } from "@/lib/utils";

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

export default function DiscordPage() {
  const c = useDiscordChecker();
  const s = c.snapshot;
  const fill = ((c.rate - 1) / (DISCORD_MAX_RATE - 1)) * 100;
  const def = DISCORD_MODE_BY_ID[c.mode]!;
  const canStart = c.validation.status === "ok";

  return (
    <>
      <PageHeader title="Discord" />

      <div className="space-y-4">
        <Panel>
          <Eyebrow>Mode</Eyebrow>
          <div className="mt-4">
            <ModePicker mode={c.mode} onSelect={c.setMode} disabled={c.isRunning} modes={Object.values(DISCORD_MODE_BY_ID)} />
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
              <ModeForm
                mode={def} params={c.params} onChange={c.setParams} disabled={c.isRunning}
                lengthMin={DISCORD_LENGTH_MIN} lengthMax={DISCORD_LENGTH_MAX}
              />
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
              <label htmlFor="discord-rate" className="text-sm font-medium">Rate</label>
              <span className="tabular font-mono text-sm text-primary">{c.rate}/s</span>
            </div>
            <input
              id="discord-rate"
              type="range"
              min={1}
              max={DISCORD_MAX_RATE}
              step={1}
              value={c.rate}
              disabled={c.isRunning}
              onChange={(e) => c.setRate(Number(e.target.value))}
              style={{ "--fill": `${fill}%` } as CSSProperties}
              className="range mt-2"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Discord's unauthenticated check endpoint has no proxy pool behind it here, so the rate is capped well below the Xbox checker's.
            </p>
          </div>
        </Panel>

        <Panel>
          <Eyebrow>Progress</Eyebrow>
          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label="Checked" value={s?.attempts ?? 0} />
            <Stat label="Available" value={s?.found ?? 0} accent />
            <Stat label="Taken" value={s?.taken ?? 0} />
            <Stat label="Unknown" value={s?.unknown ?? 0} />
          </div>
        </Panel>

        <ActivityFeed
          title="Live feed"
          events={c.feed}
          connected={c.feedConnected}
          onClear={c.clearFeed}
          platform="discord"
        />
      </div>
    </>
  );
}

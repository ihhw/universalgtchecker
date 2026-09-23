import { memo, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatClock, PLATFORM_LABEL, type ActivityEvent, type FeedStatus } from "@/lib/api";
import { Panel } from "@/components/panel";

type Filter = "all" | FeedStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "ALL" },
  { id: "available", label: "AVAILABLE" },
  { id: "taken", label: "TAKEN" },
  { id: "unknown", label: "UNKNOWN" },
];

const MAX_ROWS = 120; // rendered rows; the hook keeps a larger bounded history

const STATUS_STYLE: Record<FeedStatus, string> = {
  available: "font-semibold text-primary",
  taken: "text-muted-foreground",
  unknown: "text-muted-foreground/55",
};

const Row = memo(function Row({ e, showPlatform }: { e: ActivityEvent; showPlatform: boolean }) {
  return (
    <li
      className={cn(
        "grid items-center gap-x-3 border-b border-border/60 px-4 py-2 font-mono text-[13px] last:border-b-0",
        showPlatform
          ? "grid-cols-[64px_minmax(0,1fr)_76px_78px] sm:grid-cols-[76px_minmax(0,1fr)_72px_104px_100px]"
          : "grid-cols-[64px_minmax(0,1fr)_76px_78px] sm:grid-cols-[76px_minmax(0,1fr)_112px_104px]",
        e.status === "available" && "bg-primary/[0.05]",
      )}
    >
      <span className="text-muted-foreground/70">{formatClock(e.ts)}</span>
      <span className="truncate font-semibold tracking-wide text-foreground">{e.username}</span>
      {showPlatform && (
        <span className="hidden text-muted-foreground sm:block">{PLATFORM_LABEL[e.platform]}</span>
      )}
      <span className="text-muted-foreground">{e.format}</span>
      <span
        className={cn("text-right sm:text-left", STATUS_STYLE[e.status])}
        title={e.policy ? `Double Check: ${e.policy}` : undefined}
      >
        {e.status.toUpperCase()}
      </span>
    </li>
  );
});

interface ActivityFeedProps {
  title: string;
  events: ActivityEvent[];
  connected: boolean;
  onClear: () => void;
  showPlatform?: boolean;
  platform?: ActivityEvent["platform"];
  /** Max height of the scrolling list. */
  listClassName?: string;
}

/**
 * Renders real backend events. Hiding or clearing only affects this browser's
 * view: the checker keeps running and the backend log is not modified.
 */
export function ActivityFeed({
  title, events, connected, onClear, showPlatform = false, platform, listClassName,
}: ActivityFeedProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [hidden, setHidden] = useState(false);

  const rows = useMemo(() => {
    const out: ActivityEvent[] = [];
    for (const e of events) {
      if (platform && e.platform !== platform) continue;
      if (filter !== "all" && e.status !== filter) continue;
      out.push(e);
      if (out.length >= MAX_ROWS) break;
    }
    return out;
  }, [events, filter, platform]);

  return (
    <Panel>
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">{title}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setHidden((v) => !v)}
            aria-pressed={hidden}
            className="rounded-lg border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {hidden ? "Show Feed" : "Hide Feed"}
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter feed">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={cn(
              "rounded-lg border px-3 py-1.5 font-mono text-[11px] tracking-wide transition-colors",
              filter === f.id
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <p className="mt-4 flex items-center gap-2 font-mono text-[11px] text-muted-foreground" role="status">
        <span
          aria-hidden="true"
          className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-primary" : "bg-muted-foreground/50")}
        />
        {connected ? "Live" : "Reconnecting"}
      </p>

      {hidden ? (
        <div className="mt-3 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-10 text-center text-sm text-muted-foreground">
          Feed hidden
        </div>
      ) : (
        <ul
          className={cn(
            "mt-3 max-h-[420px] overflow-y-auto rounded-lg border border-border bg-[hsl(var(--well))]",
            listClassName,
          )}
        >
          {rows.length === 0 ? (
            <li className="px-4 py-10 text-center text-sm text-muted-foreground">
              No activity yet
            </li>
          ) : (
            rows.map((e) => <Row key={e.id} e={e} showPlatform={showPlatform} />)
          )}
        </ul>
      )}

    </Panel>
  );
}

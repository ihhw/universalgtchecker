import { Panel, PageHeader } from "@/components/panel";
import { useChecker } from "@/state/checker";
import { useSystemStatus, type ServiceState } from "@/hooks/use-system-status";
import { cn } from "@/lib/utils";

const STATE_STYLE: Record<ServiceState, { text: string; dot: string; label: string }> = {
  online: { text: "text-primary", dot: "bg-primary", label: "ONLINE" },
  degraded: { text: "text-primary/70", dot: "bg-primary/50", label: "DEGRADED" },
  offline: { text: "text-destructive", dot: "bg-destructive", label: "OFFLINE" },
  unknown: { text: "text-muted-foreground", dot: "bg-muted-foreground/50", label: "UNKNOWN" },
};

const POLL_MS = 5_000;

export default function StatusPage() {
  const { feedConnected } = useChecker();
  const { rows: baseRows, apiReachable, checkedAt, loading } = useSystemStatus();

  const rows = baseRows.map((s) =>
    s.id === "realtime"
      ? { ...s, detail: `${s.detail} · browser ${feedConnected ? "live" : "polling"}` }
      : s,
  );

  return (
    <>
      <PageHeader title="System status" />
      <Panel>
        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground" role="status">Checking…</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.map((s) => {
              const st = STATE_STYLE[s.state];
              return (
                <li key={s.id} className="flex items-center gap-4 py-4 first:pt-0 last:pb-0">
                  <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", st.dot)} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium">{s.label}</p>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">{s.detail}</p>
                  </div>
                  <span className={cn("font-mono text-[11px] tracking-wider", st.text)}>{st.label}</span>
                </li>
              );
            })}
          </ul>
        )}
        {checkedAt && apiReachable && (
          <p className="mt-5 border-t border-border pt-4 font-mono text-[11px] text-muted-foreground/60">
            Refreshes every {POLL_MS / 1000} s
          </p>
        )}
      </Panel>
    </>
  );
}

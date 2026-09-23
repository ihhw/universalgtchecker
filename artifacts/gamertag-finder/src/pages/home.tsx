import { Link } from "wouter";
import { Panel, PageHeader, Eyebrow } from "@/components/panel";
import { useChecker } from "@/state/checker";
import { useSniperTargets } from "@/hooks/use-sniper";
import { useSystemStatus } from "@/hooks/use-system-status";
import { cn } from "@/lib/utils";

function StatCard({ label, value, detail, tone = "default", href }: {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "good" | "bad" | "muted";
  href?: string;
}) {
  const toneClass = {
    default: "text-foreground",
    good: "text-primary",
    bad: "text-destructive",
    muted: "text-muted-foreground",
  }[tone];

  const body = (
    <Panel className={cn("h-full transition-colors", href && "hover:bg-secondary/40")}>
      <Eyebrow>{label}</Eyebrow>
      <p className={cn("mt-2 text-2xl font-semibold tracking-tight", toneClass)}>{value}</p>
      {detail && <p className="mt-1 text-[13px] text-muted-foreground">{detail}</p>}
    </Panel>
  );

  return href ? <Link href={href} className="block">{body}</Link> : body;
}

export default function HomePage() {
  const { isAuthed, accountReady, auth, isRunning, isPaused, snapshot, hits, feedConnected, sessionId } = useChecker();
  const { targets: sniperTargets } = useSniperTargets();
  const { rows: statusRows, apiReachable } = useSystemStatus();

  const servicesDown = statusRows.filter((s) => s.state === "offline").length;
  const statusLabel = apiReachable === false
    ? "Unreachable"
    : servicesDown > 0 ? `${servicesDown} service${servicesDown === 1 ? "" : "s"} down` : "All systems online";
  const statusTone = apiReachable === false || servicesDown > 0 ? "bad" : "good";

  const checkerLabel = !sessionId ? "Idle" : isPaused ? "Paused" : isRunning ? "Running" : "Stopped";
  const checkerDetail = sessionId && snapshot
    ? `${snapshot.attempts.toLocaleString()} checked · ${snapshot.found} found`
    : "No active search";

  const sniperActive = sniperTargets.filter((t) => t.state === "watching" || t.state === "claiming");
  const sniperLabel = sniperActive.length > 0
    ? `Watching ${sniperActive.length}`
    : sniperTargets.length > 0 ? "Idle" : "No targets";
  const sniperDetail = sniperActive.length > 0
    ? sniperActive.map((t) => t.config.target).join(", ")
    : "No targets watching";

  const accountLabel = !isAuthed ? "Not connected" : accountReady ? "Ready" : "Needs attention";
  const accountDetail = isAuthed
    ? (auth.status?.account?.gamertag ?? auth.status?.account?.reason ?? "Verifying…")
    : "Connect Xbox to enable claims";

  return (
    <>
      <PageHeader title="Command Center" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="System status"
          value={statusLabel}
          tone={statusTone}
          href="/status"
        />
        <StatCard
          label="Xbox account"
          value={accountLabel}
          detail={accountDetail}
          tone={!isAuthed ? "muted" : accountReady ? "good" : "bad"}
        />
        <StatCard
          label="Live activity"
          value={feedConnected ? "Live" : "Polling"}
          detail={`${hits.length} hit${hits.length === 1 ? "" : "s"} this session`}
          tone={feedConnected ? "good" : "muted"}
          href="/activity"
        />
        <StatCard
          label="Checker"
          value={checkerLabel}
          detail={checkerDetail}
          tone={isRunning ? "good" : "muted"}
          href="/xbox"
        />
        <StatCard
          label="Sniper"
          value={sniperLabel}
          detail={sniperDetail}
          tone={sniperActive.length > 0 ? "good" : "muted"}
          href="/xbox/sniper"
        />
        <StatCard
          label="Hits saved"
          value={String(hits.length)}
          detail="Confirmed available results"
          href="/hits"
        />
      </div>

      <Panel className="mt-6">
        <Eyebrow>Quick actions</Eyebrow>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/xbox" className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-secondary">
            Open Checker
          </Link>
          <Link href="/xbox/sniper" className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-secondary">
            Open Sniper
          </Link>
          <Link href="/settings" className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-secondary">
            Settings
          </Link>
        </div>
      </Panel>
    </>
  );
}

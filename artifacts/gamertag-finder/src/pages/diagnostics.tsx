import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Panel, Eyebrow, PageHeader } from "@/components/panel";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Diagnostics {
  process: {
    nodeVersion: string;
    platform: string;
    arch: string;
    pid: number;
    uptimeMs: number;
    env: string;
    memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  };
  config: {
    xboxClientIdSet: boolean;
    xboxMockBase: boolean;
    logLevel: string;
    discordWebhookConfigured: boolean;
  };
  buffers: {
    activityEvents: number;
    activityHits: number;
    activityStreamClients: number;
    claimRecords: number;
  };
  checker: { running: number; total: number; sseClients: number };
  sniper: { totalTargets: number; activeTargets: number };
  accounts: { total: number; ready: number };
  bot: { state: "online" | "offline" | "unknown"; detail: string };
  analyticsTotals: { checks: number; available: number; taken: number; unknown: number; claimAttempts: number; claimsSucceeded: number; claimsFailed: number };
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <span className="eyebrow shrink-0">{label}</span>
      <span className={cn("min-w-0 truncate text-right text-[13px]", mono && "font-mono")}>{children}</span>
    </div>
  );
}

function Bool({ v }: { v: boolean }) {
  return <span className={v ? "text-primary" : "text-muted-foreground"}>{v ? "YES" : "NO"}</span>;
}

export default function DiagnosticsPage() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [reachable, setReachable] = useState(true);
  const [testingWebhook, setTestingWebhook] = useState(false);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const res = await fetch(api("/diagnostics"));
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as Diagnostics;
        if (!disposed) { setData(d); setReachable(true); }
      } catch {
        if (!disposed) setReachable(false);
      }
    };
    void load();
    const t = setInterval(load, 5_000);
    return () => { disposed = true; clearInterval(t); };
  }, []);

  const testWebhook = async () => {
    setTestingWebhook(true);
    try {
      const res = await fetch(api("/diagnostics/test-webhook"), { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (d.ok) toast.success("Test message sent — check your Discord channel.");
      else toast.error(d.error ?? "Could not send the test message.");
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setTestingWebhook(false);
    }
  };

  return (
    <>
      <PageHeader title="Diagnostics" />

      {!reachable && (
        <p role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-4 py-3 text-sm">
          Could not reach the server.
        </p>
      )}

      {!data ? (
        <Panel><p className="py-8 text-center text-sm text-muted-foreground">Loading…</p></Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel>
            <Eyebrow>Process</Eyebrow>
            <div className="mt-3">
              <Row label="Node version" mono>{data.process.nodeVersion}</Row>
              <Row label="Platform" mono>{data.process.platform} / {data.process.arch}</Row>
              <Row label="PID" mono>{data.process.pid}</Row>
              <Row label="Uptime" mono>{fmtUptime(data.process.uptimeMs)}</Row>
              <Row label="Environment" mono>{data.process.env}</Row>
              <Row label="Memory (RSS)" mono>{data.process.memory.rssMb} MB</Row>
              <Row label="Heap" mono>{data.process.memory.heapUsedMb} / {data.process.memory.heapTotalMb} MB</Row>
            </div>
          </Panel>

          <Panel>
            <Eyebrow>Configuration</Eyebrow>
            <div className="mt-3">
              <Row label="Xbox client ID set"><Bool v={data.config.xboxClientIdSet} /></Row>
              <Row label="Mock Xbox base (dev)"><Bool v={data.config.xboxMockBase} /></Row>
              <Row label="Log level" mono>{data.config.logLevel}</Row>
              <Row label="Discord webhook configured"><Bool v={data.config.discordWebhookConfigured} /></Row>
            </div>
            <button
              type="button"
              disabled={!data.config.discordWebhookConfigured || testingWebhook}
              onClick={() => void testWebhook()}
              className="mt-4 w-full rounded-lg border border-border py-2 text-sm transition-colors hover:bg-secondary disabled:opacity-40"
            >
              {testingWebhook ? "Sending…" : "Send test webhook message"}
            </button>
          </Panel>

          <Panel>
            <Eyebrow>In-memory buffers</Eyebrow>
            <div className="mt-3">
              <Row label="Activity events" mono>{data.buffers.activityEvents} / 500</Row>
              <Row label="Hits" mono>{data.buffers.activityHits} / 200</Row>
              <Row label="Activity SSE clients" mono>{data.buffers.activityStreamClients}</Row>
              <Row label="Claim records" mono>{data.buffers.claimRecords} / 200</Row>
            </div>
          </Panel>

          <Panel>
            <Eyebrow>Engines</Eyebrow>
            <div className="mt-3">
              <Row label="Checker sessions" mono>{data.checker.running} running / {data.checker.total} total</Row>
              <Row label="Checker SSE clients" mono>{data.checker.sseClients}</Row>
              <Row label="Sniper targets" mono>{data.sniper.activeTargets} active / {data.sniper.totalTargets} total</Row>
              <Row label="Xbox accounts" mono>{data.accounts.ready} ready / {data.accounts.total} total</Row>
              <Row label="Discord bot">
                <span className={data.bot.state === "online" ? "text-primary" : data.bot.state === "offline" ? "text-destructive" : "text-muted-foreground"}>
                  {data.bot.detail}
                </span>
              </Row>
            </div>
          </Panel>

          <Panel className="lg:col-span-2">
            <Eyebrow>Today's totals</Eyebrow>
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {([
                ["Checks", data.analyticsTotals.checks],
                ["Available", data.analyticsTotals.available],
                ["Taken", data.analyticsTotals.taken],
                ["Claim attempts", data.analyticsTotals.claimAttempts],
              ] as const).map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-3">
                  <p className="eyebrow">{label}</p>
                  <p className="tabular mt-1.5 text-xl font-semibold">{value.toLocaleString()}</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}

import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Download } from "lucide-react";
import { Panel, Eyebrow, PageHeader } from "@/components/panel";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface DayBucket {
  date: string;
  checks: number;
  available: number;
  taken: number;
  unknown: number;
  claimAttempts: number;
  claimsSucceeded: number;
  claimsFailed: number;
}

interface StatsSummary {
  days: DayBucket[];
  totals: Omit<DayBucket, "date">;
}

const WINDOWS = [7, 30, 90] as const;

function pct(n: number, of: number): string {
  return of === 0 ? "—" : `${Math.round((n / of) * 100)}%`;
}

function StatTile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "good" | "bad" | "muted" }) {
  return (
    <div className="rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className={cn(
        "tabular mt-1.5 text-2xl font-semibold",
        tone === "good" && "text-primary",
        tone === "bad" && "text-destructive",
        tone === "muted" && "text-muted-foreground",
      )}>
        {value}
      </p>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function toCsv(days: DayBucket[]): string {
  const header = ["date", "checks", "available", "taken", "unknown", "claimAttempts", "claimsSucceeded", "claimsFailed"];
  const rows = days.map((d) => header.map((k) => String(d[k as keyof DayBucket])).join(","));
  return [header.join(","), ...rows].join("\n");
}

function downloadText(filename: string, text: string, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AnalyticsPage() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [data, setData] = useState<StatsSummary | null>(null);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(api(`/analytics?days=${days}`), { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as StatsSummary;
        if (!disposed) { setData(d); setReachable(true); }
      } catch {
        if (!disposed && !controller.signal.aborted) setReachable(false);
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, [days]);

  const totals = data?.totals;
  const series = data?.days ?? [];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <PageHeader title="Analytics" />
        <div className="mb-6 flex items-center gap-1.5" role="radiogroup" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={days === w}
              onClick={() => setDays(w)}
              className={cn(
                "rounded-md border px-3 py-1.5 font-mono text-xs transition-colors",
                days === w ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {!reachable && (
        <p role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-4 py-3 text-sm">
          Could not reach the server. Analytics figures below may be stale.
        </p>
      )}

      <Panel>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          <StatTile label="Total checks" value={(totals?.checks ?? 0).toLocaleString()} detail="All-time, every retained day" />
          <StatTile label="Available found" value={(totals?.available ?? 0).toLocaleString()} tone="good" />
          <StatTile label="Taken" value={(totals?.taken ?? 0).toLocaleString()} tone="muted" />
          <StatTile
            label="Hit rate"
            value={totals ? pct(totals.available, totals.checks) : "—"}
            detail="Available ÷ checks"
          />
          <StatTile label="Claim attempts" value={(totals?.claimAttempts ?? 0).toLocaleString()} />
          <StatTile label="Claims succeeded" value={(totals?.claimsSucceeded ?? 0).toLocaleString()} tone="good" />
          <StatTile label="Claims failed" value={(totals?.claimsFailed ?? 0).toLocaleString()} tone={totals && totals.claimsFailed > 0 ? "bad" : "muted"} />
          <StatTile
            label="Claim success rate"
            value={totals ? pct(totals.claimsSucceeded, totals.claimAttempts) : "—"}
            detail="Succeeded ÷ attempts"
          />
        </div>
      </Panel>

      <Panel className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Eyebrow>Checks per day</Eyebrow>
          <button
            type="button"
            onClick={() => downloadText(`analytics-${days}d.csv`, toCsv(series), "text/csv")}
            disabled={series.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            EXPORT CSV
          </button>
        </div>
        <div className="mt-4 h-[280px]">
          {series.length === 0 ? (
            <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No data yet. Run a check or a sniper watch to see activity here.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickFormatter={(d: string) => d.slice(5)}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  tickLine={false}
                />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "hsl(var(--foreground))", fontWeight: 600 }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="available" name="Available" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 0, 0]} />
                <Bar dataKey="taken" name="Taken" stackId="a" fill="hsl(var(--accent))" />
                <Bar dataKey="unknown" name="Unknown" stackId="a" fill="hsl(var(--muted-foreground))" fillOpacity={0.4} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </Panel>
    </>
  );
}

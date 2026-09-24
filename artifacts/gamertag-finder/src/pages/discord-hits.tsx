import { Download } from "lucide-react";
import { toast } from "sonner";
import { Panel, Eyebrow, PageHeader } from "@/components/panel";
import { useDiscordChecker } from "@/state/discord-checker";
import { formatClock } from "@/lib/api";
import { cn } from "@/lib/utils";

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${text}`);
  } catch {
    toast.error("Could not copy to the clipboard.");
  }
}

function exportHitsCsv(hits: { username: string; format: string; ts: number }[]) {
  const header = ["username", "mode", "found_at"];
  const rows = hits.map((h) => [h.username, h.format, new Date(h.ts).toISOString()]
    .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  const csv = [header.join(","), ...rows].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "discord-hits.csv";
  a.click();
  URL.revokeObjectURL(url);
}

const btn =
  "rounded-lg border border-border px-3 py-1.5 font-mono text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-default disabled:opacity-50";

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-md border border-primary/40 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-primary">
      {children}
    </span>
  );
}

export default function DiscordHitsPage() {
  const c = useDiscordChecker();
  const hits = [...c.hits].filter((h) => h.platform === "discord").reverse();

  return (
    <>
      <PageHeader title="Discord Hits" />
      <div className="space-y-4">
        <Panel>
          <div className="flex items-center justify-between">
            <Eyebrow>Found</Eyebrow>
            {hits.length > 0 && (
              <button
                type="button"
                className={cn(btn, "inline-flex items-center gap-1.5")}
                onClick={() => exportHitsCsv(hits)}
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </button>
            )}
          </div>
          {hits.length === 0 ? (
            <p className="mt-4 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-10 text-center text-sm text-muted-foreground">
              No hits yet
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-border/60 rounded-lg border border-border bg-[hsl(var(--well))]">
              {hits.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-lg font-semibold tracking-wide text-primary">
                      {h.username}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Chip>AVAILABLE</Chip>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {h.format} · {formatClock(h.ts)}
                      </span>
                    </span>
                  </div>
                  <button type="button" className={btn} onClick={() => void copy(h.username)}>Copy</button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Panel, Eyebrow, PageHeader } from "@/components/panel";
import { useChecker, type ClaimStatus } from "@/state/checker";
import { formatClock } from "@/lib/api";
import { cn } from "@/lib/utils";

const CLAIM_LABEL: Record<ClaimStatus, string> = {
  idle: "Claim",
  claiming: "Claiming",
  claimed: "Claimed",
  error: "Retry",
  rate_limited: "Retry",
  auth_failed: "Reconnect",
  auth_required: "Connect",
  rejected: "Rejected",
};

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${text}`);
  } catch {
    toast.error("Could not copy to the clipboard.");
  }
}

const btn =
  "rounded-lg border border-border px-3 py-1.5 font-mono text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-default disabled:opacity-50";

/** Separate states: a hit is Available; Double Check approval and Claimed are their own facts. */
function Chip({ children, tone }: { children: string; tone: "gold" | "muted" }) {
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-0.5 font-mono text-[10px] tracking-wide",
        tone === "gold" ? "border-primary/40 text-primary" : "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export default function HitsPage() {
  const c = useChecker();
  const hits = [...c.hits].reverse();

  return (
    <>
      <PageHeader title="Hits" />
      <div className="space-y-4">
        <Panel>
          <Eyebrow>Found</Eyebrow>
          {hits.length === 0 ? (
            <p className="mt-4 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-10 text-center text-sm text-muted-foreground">
              No hits yet
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-border/60 rounded-lg border border-border bg-[hsl(var(--well))]">
              {hits.map((h) => {
                const status = c.claimStatuses.get(h.username) ?? "idle";
                const busy = status === "claiming";
                const done = status === "claimed" || status === "rejected" || busy;
                return (
                  <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-lg font-semibold tracking-wide text-primary">
                        {h.username}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Chip tone="gold">AVAILABLE</Chip>
                        {h.policy === "approved" && <Chip tone="gold">DOUBLE CHECK APPROVED</Chip>}
                        {status === "claimed" && <Chip tone="gold">CLAIMED</Chip>}
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {h.format} · {formatClock(h.ts)}
                        </span>
                      </span>
                    </div>
                    <span className="flex items-center gap-2">
                      <button type="button" className={btn} onClick={() => void copy(h.username)}>Copy</button>
                      <button
                        type="button"
                        className={btn}
                        disabled={c.saved.includes(h.username)}
                        onClick={() => c.save(h.username)}
                      >
                        {c.saved.includes(h.username) ? "Saved" : "Save"}
                      </button>
                      <button
                        type="button"
                        className={cn(btn, status === "claimed" && "border-primary/50 text-primary")}
                        disabled={done}
                        aria-busy={busy}
                        onClick={() => void c.claim(h.username)}
                      >
                        {busy ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Loader2 className="h-3 w-3 animate-spin" /> Claiming
                          </span>
                        ) : (
                          CLAIM_LABEL[status]
                        )}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel>
          <div className="flex items-center justify-between">
            <Eyebrow>Saved</Eyebrow>
            {c.saved.length > 0 && (
              <button type="button" className={cn(btn, "inline-flex items-center gap-1.5")} onClick={c.exportSaved}>
                <Download className="h-3.5 w-3.5" />
                Export
              </button>
            )}
          </div>
          {c.saved.length === 0 ? (
            <p className="mt-4 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing saved
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-border/60 rounded-lg border border-border bg-[hsl(var(--well))]">
              {c.saved.map((tag) => {
                const status = c.claimStatuses.get(tag) ?? "idle";
                const busy = status === "claiming";
                return (
                  <li key={tag} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1 truncate font-mono text-base font-semibold tracking-wide">{tag}</span>
                    <button type="button" className={btn} onClick={() => void copy(tag)}>Copy</button>
                    <button
                      type="button"
                      className={btn}
                      disabled={status === "claimed" || status === "rejected" || busy}
                      aria-busy={busy}
                      onClick={() => void c.claim(tag)}
                    >
                      {CLAIM_LABEL[status]}
                    </button>
                    <button type="button" className={btn} onClick={() => c.unsave(tag)}>Remove</button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

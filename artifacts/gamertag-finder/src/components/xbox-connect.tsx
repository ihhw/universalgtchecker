import { useEffect, useRef } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useChecker } from "@/state/checker";
import { cn } from "@/lib/utils";

/** Bottom-left sidebar control. */
export function ConnectXboxButton({ className }: { className?: string }) {
  const { isAuthed, setConnectOpen } = useChecker();
  return (
    <button
      type="button"
      onClick={() => setConnectOpen(true)}
      className={cn(
        "flex w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-card px-4 py-3",
        "text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-secondary",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("h-2 w-2 rounded-full", isAuthed ? "bg-primary" : "bg-muted-foreground/50")}
      />
      {isAuthed ? "Xbox connected" : "Connect Xbox"}
    </button>
  );
}

/** Microsoft device-code sign-in. The code and tokens are handled by the API server. */
export function ConnectXboxDialog() {
  const { connectOpen, setConnectOpen, auth, isAuthed } = useChecker();
  const { status, loading, startAuth, logout } = auth;
  const code = status?.deviceCode ?? null;
  const pending = code?.status === "pending";
  const requested = useRef(false);

  // Request a code when the dialog opens and there is none pending.
  useEffect(() => {
    if (!connectOpen) { requested.current = false; return; }
    if (status === null || isAuthed || pending || loading || requested.current) return;
    requested.current = true;
    void startAuth();
  }, [connectOpen, status, isAuthed, pending, loading, startAuth]);

  // Close automatically shortly after sign-in completes.
  useEffect(() => {
    if (connectOpen && isAuthed && code?.status === "authorized") {
      const t = setTimeout(() => setConnectOpen(false), 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [connectOpen, isAuthed, code?.status, setConnectOpen]);

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.userCode);
      toast.success("Code copied");
    } catch {
      toast.error("Could not copy. Select the code and copy it manually.");
    }
  };

  return (
    <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
      <DialogContent className="max-w-md gap-0 rounded-xl border-border bg-card p-0 sm:rounded-xl">
        <div className="border-b border-border px-6 py-4">
          <DialogTitle className="eyebrow">Xbox account</DialogTitle>
          <DialogDescription className="sr-only">
            Sign in to Xbox with a Microsoft device code.
          </DialogDescription>
        </div>

        <div className="space-y-6 px-6 py-6">
          {isAuthed ? (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Check className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium">Xbox connected</p>
                  <p className="text-xs text-muted-foreground">Authenticated checks and claiming are available.</p>
                </div>
              </div>
              <button
                type="button"
                disabled={loading}
                onClick={async () => { await logout(); toast.info("Signed out of Xbox"); }}
                className="w-full rounded-lg border border-border py-2.5 text-sm transition-colors hover:bg-secondary disabled:opacity-50"
              >
                {loading ? "Signing out…" : "Sign out"}
              </button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">1. Open this link in a browser:</p>
                <a
                  href={code?.verificationUri ?? "https://www.microsoft.com/link"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block break-all text-sm font-medium text-primary underline underline-offset-4"
                >
                  {code?.verificationUri ?? "https://www.microsoft.com/link"}
                </a>
              </div>

              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">2. Enter this code:</p>
                <div className="flex items-center gap-3 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-3">
                  <span className="flex-1 select-all font-mono text-2xl font-semibold tracking-[0.28em]">
                    {pending && code ? code.userCode : loading ? "········" : "--------"}
                  </span>
                  <button
                    type="button"
                    onClick={copy}
                    disabled={!pending}
                    aria-label="Copy code"
                    className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {pending ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Waiting for sign-in…
                </p>
              ) : code && (code.status === "expired" || code.status === "error") ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {code.status === "expired" ? "This code expired." : "Sign-in failed."} Request a new one.
                  </p>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void startAuth()}
                    className="w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    New code
                  </button>
                </div>
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Requesting a code…
                </p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

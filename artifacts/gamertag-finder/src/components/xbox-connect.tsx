import { useEffect, useRef, type ReactNode } from "react";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useChecker } from "@/state/checker";
import type { XboxAccountStatus } from "@/hooks/use-xbox-auth";
import { cn } from "@/lib/utils";

const STAGE_LABEL: Record<XboxAccountStatus["stage"], string> = {
  none: "Not verified",
  microsoft: "Microsoft sign-in",
  xbox_live: "Xbox Live",
  xsts: "Xbox authorization (XSTS)",
  xuid: "Xbox identity (XUID)",
  ready: "Ready",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <span className="eyebrow shrink-0">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-[13px]">{children}</span>
    </div>
  );
}

/**
 * Account status block shared by the dialog and the Sniper page. Shows only
 * what the server verified; never a token.
 */
export function XboxAccountSummary({ account, className }: { account: XboxAccountStatus | undefined; className?: string }) {
  if (!account) return null;
  const ready = account.ready;
  return (
    <div className={cn("space-y-3", className)}>
      <p className="flex items-center gap-2 text-sm font-semibold tracking-wide" role="status">
        <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", ready ? "bg-primary" : "bg-destructive")} />
        {ready ? "CONNECTED" : account.connected ? "NOT READY" : "NOT CONNECTED"}
      </p>
      <div className="rounded-lg border border-border bg-[hsl(var(--well))] px-3.5">
        <Row label="Account">{account.maskedEmail ?? "Email not shared — reconnect to show it"}</Row>
        <Row label="Xbox identity">
          {account.gamertag ? `${account.gamertag}${account.maskedXuid ? ` · ${account.maskedXuid}` : ""}` : "—"}
        </Row>
        <Row label="Claiming">
          <span className={ready ? "text-primary" : "text-destructive"}>{ready ? "READY" : "NOT READY"}</span>
        </Row>
      </div>
      {!ready && account.reason && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3.5 py-3 text-[13px] leading-relaxed">
          <p className="eyebrow mb-1">Reason · {STAGE_LABEL[account.stage]}</p>
          {account.reason}
          {account.code && <span className="ml-1 font-mono text-xs text-muted-foreground">({account.code})</span>}
        </div>
      )}
    </div>
  );
}

/** Bottom-left sidebar control. */
export function ConnectXboxButton({ className }: { className?: string }) {
  const { isAuthed, accountReady, setConnectOpen } = useChecker();
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
        className={cn(
          "h-2 w-2 rounded-full",
          accountReady ? "bg-primary" : isAuthed ? "bg-destructive" : "bg-muted-foreground/50",
        )}
      />
      {accountReady ? "Xbox connected" : isAuthed ? "Xbox not ready" : "Connect Xbox"}
    </button>
  );
}

/** Microsoft device-code sign-in. The code and tokens are handled by the API server. */
export function ConnectXboxDialog() {
  const { connectOpen, setConnectOpen, auth, isAuthed } = useChecker();
  const { status, loading, startAuth, logout, verify } = auth;
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

  // Close automatically shortly after sign-in completes AND the account is
  // verified ready; a not-ready account stays open so the reason is visible.
  const ready = status?.account?.ready === true;
  useEffect(() => {
    if (connectOpen && ready && code?.status === "authorized") {
      const t = setTimeout(() => setConnectOpen(false), 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [connectOpen, ready, code?.status, setConnectOpen]);

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
              {status?.account?.checkedAt === null ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Verifying Xbox Live, XSTS and XUID…
                </p>
              ) : (
                <XboxAccountSummary account={status?.account} />
              )}
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void verify()}
                  className="rounded-lg border border-primary/50 py-2.5 text-sm text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                >
                  {loading ? "Checking…" : "Verify again"}
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={async () => { await logout(); toast.info("Signed out of Xbox"); }}
                  className="rounded-lg border border-border py-2.5 text-sm transition-colors hover:bg-secondary disabled:opacity-50"
                >
                  Sign out
                </button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                You signed in on Microsoft&apos;s own page. This app never sees your password; tokens stay on the server.
              </p>
            </div>
          ) : (
            <>
              {status?.account?.code === "invalid_grant" && (
                <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3.5 py-3 text-[13px]">
                  {status.account.reason}
                </p>
              )}
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
                    {code.status === "expired" ? "This code expired." : `Sign-in failed${code.error ? ` (${code.error})` : ""}.`} Request a new one.
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

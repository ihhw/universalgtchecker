import { useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, ExternalLink, Loader2, Plus, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useChecker } from "@/state/checker";
import type { XboxAccountStatus } from "@/hooks/use-xbox-auth";
import { useXboxAccounts } from "@/hooks/use-xbox-accounts";
import { api } from "@/lib/api";
import { generateStrongPassword, suggestEmailLocalPart } from "@/lib/generate-credentials";
import { cn } from "@/lib/utils";

/** Best-effort audit note for the 3 steps of account creation the server can't observe directly (the user filling out Microsoft's own form). Never blocks the UI if it fails. */
function logClientAudit(event: "ACCOUNT_CREATION_STARTED" | "ACCOUNT_CREATION_AWAITING_USER" | "ACCOUNT_CREATION_CONFIRMED") {
  void fetch(api("/audit/client"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
  }).catch(() => { /* non-critical */ });
}

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

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error(`Could not copy the ${label.toLowerCase()}. Select it manually.`);
  }
}

const MICROSOFT_SIGNUP_URL = "https://signup.live.com/signup";

/**
 * Assisted Microsoft account creation. This only ever: suggests an email
 * local-part and a strong password, opens Microsoft's own signup page in a
 * new tab, and — once the user confirms they finished it there — starts the
 * exact same device-code sign-in the app already uses for "Connect Xbox".
 * It never touches CAPTCHA, phone/email verification, or any of Microsoft's
 * anti-abuse checks; those stay entirely on Microsoft's page, for the user
 * to complete themselves.
 */
function AccountCreator({ onConnectNew }: { onConnectNew: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(() => suggestEmailLocalPart());
  const [password, setPassword] = useState(() => generateStrongPassword());
  const [signupOpened, setSignupOpened] = useState(false);

  const regenerate = () => {
    setEmail(suggestEmailLocalPart());
    setPassword(generateStrongPassword());
    setSignupOpened(false);
  };

  const start = () => {
    setOpen(true);
    setSignupOpened(false);
    logClientAudit("ACCOUNT_CREATION_STARTED");
  };

  const openSignup = () => {
    window.open(MICROSOFT_SIGNUP_URL, "_blank", "noopener,noreferrer");
    setSignupOpened(true);
    logClientAudit("ACCOUNT_CREATION_AWAITING_USER");
  };

  const confirmAndConnect = () => {
    logClientAudit("ACCOUNT_CREATION_CONFIRMED");
    setOpen(false);
    onConnectNew();
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={start}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
      >
        <UserPlus className="h-4 w-4" />
        Create Microsoft account
      </button>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Account creator</p>
        <button type="button" onClick={regenerate} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          <RefreshCw className="h-3 w-3" />
          Regenerate
        </button>
      </div>

      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Suggested details for a new Microsoft account. You'll pick the domain (outlook.com, etc.) and complete
        any verification Microsoft asks for — CAPTCHA, phone or email — yourself, on Microsoft's own page.
      </p>

      <div className="space-y-2.5">
        <div>
          <label className="eyebrow mb-1 block">Suggested email (local part)</label>
          <div className="flex items-center gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              spellCheck={false}
              className="w-full rounded-lg border border-input bg-[hsl(var(--well))] px-3 py-2 font-mono text-sm"
            />
            <button type="button" onClick={() => void copyText(email, "Email")} className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground">
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div>
          <label className="eyebrow mb-1 block">Suggested password</label>
          <div className="flex items-center gap-2">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              spellCheck={false}
              className="w-full rounded-lg border border-input bg-[hsl(var(--well))] px-3 py-2 font-mono text-sm"
            />
            <button type="button" onClick={() => void copyText(password, "Password")} className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground">
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Save these somewhere safe — this app does not store them.</p>
      </div>

      <div className="space-y-2.5 border-t border-border pt-4">
        <button
          type="button"
          onClick={openSignup}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          <ExternalLink className="h-4 w-4" />
          Open Microsoft signup page
        </button>
        <p className="text-xs text-muted-foreground">
          Complete sign-up there, including any verification Microsoft requires. Come back here when done.
        </p>
        <button
          type="button"
          disabled={!signupOpened}
          onClick={confirmAndConnect}
          className="w-full rounded-lg border border-primary/50 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          I've created the account — connect it
        </button>
        <button type="button" onClick={() => setOpen(false)} className="w-full text-center text-xs text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Every signed-in Xbox account, with the ability to switch which one claims
 * run as or forget one — the rest are untouched either way.
 */
function AccountManager({ onAddAnother }: { onAddAnother: () => void }) {
  const { accounts, busyId, activate, remove } = useXboxAccounts();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Connected accounts</p>
        <button
          type="button"
          onClick={onAddAnother}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          ADD ANOTHER
        </button>
      </div>
      {accounts === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <span
                aria-hidden="true"
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  a.rateLimitedUntil ? "bg-amber-500" : a.readiness.ready ? "bg-primary" : "bg-destructive",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                  {a.gamertag ?? a.maskedEmail ?? "Unverified account"}
                  {a.rateLimitedUntil && (
                    <span
                      title={a.rateLimitReason ?? "Rate limited"}
                      className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-amber-500"
                    >
                      Rate limited
                    </span>
                  )}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {a.rateLimitedUntil
                    ? (a.rateLimitReason ?? "Not usable right now — suspended from searching.")
                    : (a.maskedEmail ?? "Email not shared")}
                  {a.isActive && " · Active"}
                </p>
              </div>
              {!a.isActive && (
                <button
                  type="button"
                  disabled={busyId === a.id}
                  onClick={() => void activate(a.id)}
                  className="shrink-0 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-40"
                >
                  USE
                </button>
              )}
              <button
                type="button"
                disabled={busyId === a.id}
                title="Remove this account"
                onClick={() => void remove(a.id)}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
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
  const [addingAccount, setAddingAccount] = useState(false);
  const [acctVersion, setAcctVersion] = useState(0);
  const code = status?.deviceCode ?? null;
  const pending = code?.status === "pending";
  const requested = useRef(false);
  const showCodeFlow = !isAuthed || addingAccount;

  // Request a code when the dialog opens (first sign-in), or when the user
  // asked to add another account, and there is none already pending.
  useEffect(() => {
    if (!connectOpen) { requested.current = false; return; }
    if (status === null || !showCodeFlow || pending || loading || requested.current) return;
    requested.current = true;
    void startAuth();
  }, [connectOpen, status, showCodeFlow, pending, loading, startAuth]);

  // A device code flow that finishes while adding another account: stop
  // showing the code screen and refresh the account list, without closing
  // the whole dialog (the user is looking at their account list, not done).
  useEffect(() => {
    if (addingAccount && code?.status === "authorized") {
      requested.current = false;
      setAddingAccount(false);
      setAcctVersion((v) => v + 1);
      toast.success("Account added");
    }
  }, [addingAccount, code?.status]);

  // Close automatically shortly after the FIRST sign-in completes AND the
  // account is verified ready; a not-ready account stays open so the reason
  // is visible. Never auto-closes while adding an additional account.
  const ready = status?.account?.ready === true;
  useEffect(() => {
    if (connectOpen && ready && code?.status === "authorized" && !addingAccount) {
      const t = setTimeout(() => setConnectOpen(false), 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [connectOpen, ready, code?.status, addingAccount, setConnectOpen]);

  useEffect(() => { if (!connectOpen) setAddingAccount(false); }, [connectOpen]);

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
          {isAuthed && !showCodeFlow ? (
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
                  Sign out all
                </button>
              </div>
              <div className="space-y-4 border-t border-border pt-5">
                <AccountManager key={acctVersion} onAddAnother={() => { requested.current = false; setAddingAccount(true); }} />
                <AccountCreator onConnectNew={() => { requested.current = false; setAddingAccount(true); }} />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                You signed in on Microsoft&apos;s own page. This app never sees your password; tokens stay on the server.
              </p>
            </div>
          ) : (
            <>
              {addingAccount && (
                <p className="text-sm font-medium text-foreground">Adding another Xbox account</p>
              )}
              {!addingAccount && status?.account?.code === "invalid_grant" && (
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

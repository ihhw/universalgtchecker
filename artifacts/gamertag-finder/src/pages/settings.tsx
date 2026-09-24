import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Panel, Eyebrow, PageHeader } from "@/components/panel";
import { Switch } from "@/components/ui/switch";
import { useChecker } from "@/state/checker";
import { useDiscordChecker } from "@/state/discord-checker";
import { api } from "@/lib/api";

interface WebhookState {
  configured: boolean;
  enabled: boolean;
  source: "saved" | "environment" | "none";
  preview: string | null;
}

interface ProxyState {
  count: number;
  preview: string[];
  maxRate: number;
}

const btn =
  "rounded-lg border border-border px-4 py-2.5 text-sm transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50";

async function readError(res: Response): Promise<string> {
  try {
    const d = (await res.json()) as { error?: string };
    return d.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export default function SettingsPage() {
  const { autoClaim, setAutoClaim, isAuthed, setConnectOpen } = useChecker();
  const { refreshProxyState } = useDiscordChecker();
  const [webhook, setWebhook] = useState<WebhookState | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [proxyState, setProxyState] = useState<ProxyState | null>(null);
  const [proxyText, setProxyText] = useState("");
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(api("/settings/webhook"), { signal });
      if (res.ok) setWebhook((await res.json()) as WebhookState);
    } catch { /* leave the previous state */ }
    try {
      const res = await fetch(api("/discord/settings/proxies"), { signal });
      if (res.ok) setProxyState((await res.json()) as ProxyState);
    } catch { /* leave the previous state */ }
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  const sendProxies = async (method: "PUT" | "DELETE", body?: unknown): Promise<Response | null> => {
    setProxyBusy(true);
    setProxyError(null);
    try {
      const res = await fetch(api("/discord/settings/proxies"), {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) { setProxyError(await readError(res)); return null; }
      return res;
    } catch {
      setProxyError("Could not reach the server.");
      return null;
    } finally {
      setProxyBusy(false);
    }
  };

  const saveProxies = async () => {
    const res = await sendProxies("PUT", { proxies: proxyText });
    if (res) {
      const d = (await res.json()) as ProxyState & { skipped?: number };
      setProxyState(d);
      setProxyText("");
      void refreshProxyState();
      toast.success(
        d.skipped ? `Saved ${d.count} ${d.count === 1 ? "proxy" : "proxies"} (${d.skipped} skipped)` : `Saved ${d.count} ${d.count === 1 ? "proxy" : "proxies"}`,
      );
    }
  };
  const clearProxies = async () => {
    const res = await sendProxies("DELETE");
    if (res) {
      setProxyState((await res.json()) as ProxyState);
      void refreshProxyState();
      toast.info("Proxies cleared");
    }
  };

  const send = async (method: "PUT" | "DELETE" | "POST", path: string, body?: unknown): Promise<Response | null> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api(path), {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) { setError(await readError(res)); return null; }
      return res;
    } catch {
      setError("Could not reach the server.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const res = await send("PUT", "/settings/webhook", { url, enabled: true });
    if (res) { setWebhook((await res.json()) as WebhookState); setUrl(""); toast.success("Webhook saved"); }
  };
  const toggle = async (enabled: boolean) => {
    const res = await send("PUT", "/settings/webhook", { enabled });
    if (res) setWebhook((await res.json()) as WebhookState);
  };
  const remove = async () => {
    const res = await send("DELETE", "/settings/webhook");
    if (res) { setWebhook((await res.json()) as WebhookState); toast.info("Webhook removed"); }
  };
  const test = async () => {
    const res = await send("POST", "/settings/webhook/test");
    if (res) toast.success("Test message sent");
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-4">
        <Panel>
          <Eyebrow>Discord webhook</Eyebrow>
          <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Alerts for verified available gamertags only. The URL is stored on the server.
          </p>

          {webhook?.configured && (
            <div className="mt-5 flex items-center justify-between gap-4 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {webhook.source === "environment" ? "Set by server" : "Saved"}
                </p>
                {webhook.preview && (
                  <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">{webhook.preview}</p>
                )}
              </div>
              {webhook.source === "saved" && (
                <Switch
                  checked={webhook.enabled}
                  onCheckedChange={(v) => void toggle(v)}
                  disabled={busy}
                  aria-label="Send alerts"
                />
              )}
            </div>
          )}

          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
              aria-label="Discord webhook URL"
              className="min-w-0 flex-1 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-2.5 font-mono text-sm placeholder:text-muted-foreground/50 focus:border-primary/60 focus:outline-none"
            />
            <button
              type="button"
              disabled={busy || url.trim() === ""}
              onClick={() => void save()}
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
          </div>

          {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

          {webhook?.configured && (
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" className={btn} disabled={busy || !webhook.enabled} onClick={() => void test()}>
                Send test
              </button>
              {webhook.source === "saved" && (
                <button type="button" className={btn} disabled={busy} onClick={() => void remove()}>
                  Remove
                </button>
              )}
            </div>
          )}
        </Panel>

        <Panel>
          <Eyebrow>Discord proxies</Eyebrow>
          <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Discord's unauthenticated check endpoint rate-limits a single IP hard. Without proxies the
            checker stays under 50/s; with some configured, load spreads across them and up to 500/s becomes
            usable — the checker's rate slider adjusts automatically. One per line —{" "}
            <code className="font-mono text-[12px]">host:port</code>,{" "}
            <code className="font-mono text-[12px]">host:port:user:pass</code>, or{" "}
            <code className="font-mono text-[12px]">http://user:pass@host:port</code>. HTTP/HTTPS only — SOCKS
            proxies aren't supported. Stored only on the server, never sent to the browser.
          </p>

          {proxyState !== null && (
            <div className="mt-5 flex items-center justify-between gap-4 rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {proxyState.count > 0
                    ? `${proxyState.count.toLocaleString()} ${proxyState.count === 1 ? "proxy" : "proxies"} configured`
                    : "No proxies configured"}
                </p>
                {proxyState.preview.length > 0 && (
                  <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">
                    {proxyState.preview.join(", ")}
                    {proxyState.count > proxyState.preview.length ? `, +${proxyState.count - proxyState.preview.length} more` : ""}
                  </p>
                )}
              </div>
              {proxyState.count > 0 && (
                <button type="button" className={btn} disabled={proxyBusy} onClick={() => void clearProxies()}>
                  Clear
                </button>
              )}
            </div>
          )}

          <div className="mt-5">
            <textarea
              rows={6}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              value={proxyText}
              onChange={(e) => setProxyText(e.target.value)}
              placeholder={"1.2.3.4:8080\nuser:pass@1.2.3.4:8080\n1.2.3.4:8080:user:pass"}
              aria-label="Proxy list"
              className="w-full rounded-lg border border-border bg-[hsl(var(--well))] px-4 py-2.5 font-mono text-sm placeholder:text-muted-foreground/50 focus:border-primary/60 focus:outline-none"
            />
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={proxyBusy || proxyText.trim() === ""}
                onClick={() => void saveProxies()}
                className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>

          {proxyError && <p role="alert" className="mt-3 text-sm text-destructive">{proxyError}</p>}
        </Panel>

        <Panel>
          <Eyebrow>Auto-claim</Eyebrow>
          <div className="mt-3 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <label htmlFor="autoclaim" className="text-sm font-medium">Claim new hits automatically</label>
              <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
                Runs on the server for searches started while this is on, even with this tab closed.
                Only hits confirmed available (and Double Check approved when it's on) are claimed,
                and a search stops auto-claiming after its first Xbox-confirmed claim. Claims can't be undone.
              </p>
            </div>
            <Switch
              id="autoclaim"
              checked={autoClaim && isAuthed}
              onCheckedChange={(v) => {
                if (v && !isAuthed) { setConnectOpen(true); return; }
                setAutoClaim(v);
              }}
              className="mt-0.5"
            />
          </div>
        </Panel>
      </div>
    </>
  );
}

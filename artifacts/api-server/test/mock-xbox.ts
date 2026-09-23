/**
 * Local mock of the Microsoft / Xbox Live endpoints the app calls.
 *
 * TEST-ONLY. The server under test reaches it through XBOX_MOCK_BASE, which
 * rewrites https://<host>/<path> to <mock>/<host>/<path>. It models the
 * behaviour the app depends on (token audiences, XUID/gamertag claims,
 * reservations) and lets a test script any response, delay or dropped
 * connection per endpoint. It is NOT evidence of how live Xbox behaves.
 *
 * Standalone:  node --import tsx test/mock-xbox.ts  (MOCK_PORT, default 4599)
 */

import http from "node:http";
import { Buffer } from "node:buffer";

export type Endpoint = "devicecode" | "token" | "xbl" | "xsts" | "cdn" | "policy" | "reserve" | "change" | "head";

export interface Scripted {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Delay before answering, ms. */
  delayMs?: number;
  /** Destroy the socket without answering (network failure). */
  drop?: boolean;
}

export interface MockState {
  xuid: string;
  gamertag: string;
  email: string;
  taken: Set<string>;
  revoked: Set<string>;
  /** One-shot scripted responses, consumed in order, per endpoint. */
  queues: Partial<Record<Endpoint, Scripted[]>>;
  /** Response used for every call to an endpoint until cleared. */
  sticky: Partial<Record<Endpoint, Scripted>>;
  /** Extra latency added to every response, per endpoint (simulated RTT). */
  latencyMs: Partial<Record<Endpoint, number>>;
  devicePendingPolls: number;
  reservations: Map<string, string>; // TAG -> reservationId
  log: Array<{ endpoint: Endpoint | "unknown"; method: string; path: string; auth: string | null; body: unknown; at: number }>;
}

export function freshState(): MockState {
  return {
    xuid: "2533274900000001",
    gamertag: "OldTag",
    email: "tester.person@example.com",
    taken: new Set(["TAKENTAG"]),
    revoked: new Set(),
    queues: {},
    sticky: {},
    latencyMs: {},
    devicePendingPolls: 1,
    reservations: new Map(),
    log: [],
  };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: unknown) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

function classify(method: string, path: string): Endpoint | "unknown" {
  if (method === "HEAD") return "head";
  if (path.endsWith("/oauth2/v2.0/devicecode")) return "devicecode";
  if (path.endsWith("/oauth2/v2.0/token")) return "token";
  if (path.startsWith("/user.auth.xboxlive.com/")) return "xbl";
  if (path.startsWith("/xsts.auth.xboxlive.com/")) return "xsts";
  if (path.startsWith("/avatar-ssl.xboxlive.com/")) return "cdn";
  if (path.startsWith("/user.mgt.xboxlive.com/gamertags/reserve")) return "policy";
  if (path.startsWith("/gamertag.xboxlive.com/gamertags/reserve")) return "reserve";
  if (path === "/accounts.xboxlive.com/users/current/profile/gamertag") return "change";
  return "unknown";
}

export function startMockXbox(port = 0): Promise<{ url: string; state: MockState; server: http.Server; reset: () => void }> {
  let state = freshState();
  let tokenSeq = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://mock");
      const path = decodeURIComponent(url.pathname);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = Object.fromEntries(new URLSearchParams(raw)); }

      const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
        const text = payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload);
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(text);
      };

      // ── Control API (tests only) ─────────────────────────────────────────
      if (path === "/__control/reset") { state = freshState(); send(200, { ok: true }); return; }
      if (path === "/__control/log") { send(200, state.log); return; }
      if (path === "/__control/state") {
        send(200, { xuid: state.xuid, gamertag: state.gamertag, taken: [...state.taken] });
        return;
      }
      if (path === "/__control/set" && req.method === "POST") {
        const b = body as { taken?: string[]; queues?: MockState["queues"]; sticky?: MockState["sticky"]; latencyMs?: MockState["latencyMs"]; gamertag?: string };
        if (b.taken) state.taken = new Set(b.taken.map((t) => t.toUpperCase()));
        if (b.queues) for (const [k, v] of Object.entries(b.queues)) state.queues[k as Endpoint] = [...(state.queues[k as Endpoint] ?? []), ...(v ?? [])];
        if (b.sticky) Object.assign(state.sticky, b.sticky);
        if (b.latencyMs) Object.assign(state.latencyMs, b.latencyMs);
        if (b.gamertag) state.gamertag = b.gamertag;
        send(200, { ok: true });
        return;
      }

      const endpoint = classify(req.method ?? "GET", path);
      state.log.push({ endpoint, method: req.method ?? "", path, auth: (req.headers["authorization"] as string) ?? null, body, at: Date.now() });

      const extra = endpoint !== "unknown" ? state.latencyMs[endpoint] ?? 0 : 0;
      if (extra > 0) await new Promise((r) => setTimeout(r, extra));

      const scripted = endpoint !== "unknown" ? (state.queues[endpoint]?.shift() ?? state.sticky[endpoint]) : undefined;
      if (scripted) {
        if (scripted.delayMs) await new Promise((r) => setTimeout(r, scripted.delayMs));
        if (scripted.drop) { req.socket.destroy(); return; }
        if (scripted.status !== undefined) { send(scripted.status, scripted.body, scripted.headers); return; }
      }

      const auth = (req.headers["authorization"] as string | undefined) ?? "";
      // Only an XSTS token minted for http://xboxlive.com is accepted, as on Xbox.
      const xstsOk = auth.startsWith("XBL3.0 x=uhs-1;xsts|http://xboxlive.com|");
      const b = (body ?? {}) as Record<string, unknown>;

      switch (endpoint) {
        case "head": send(200); return;
        case "devicecode":
          send(200, { device_code: "dev-code-1", user_code: "MOCK1234", verification_uri: "https://www.microsoft.com/link", expires_in: 900, interval: 1 });
          return;
        case "token": {
          if (b["grant_type"] === "urn:ietf:params:oauth:grant-type:device_code") {
            if (state.devicePendingPolls-- > 0) { send(400, { error: "authorization_pending" }); return; }
            tokenSeq++;
            send(200, {
              access_token: `ms-at-${tokenSeq}`, refresh_token: `rt-${tokenSeq}`,
              id_token: jwt({ email: state.email, preferred_username: state.email }),
            });
            return;
          }
          if (b["grant_type"] === "refresh_token") {
            const rt = String(b["refresh_token"] ?? "");
            if (state.revoked.has(rt) || rt === "rt-revoked") { send(400, { error: "invalid_grant" }); return; }
            tokenSeq++;
            send(200, { access_token: `ms-at-${tokenSeq}`, refresh_token: `rt-${tokenSeq}` });
            return;
          }
          send(400, { error: "unsupported_grant_type" });
          return;
        }
        case "xbl": {
          const props = (b["Properties"] ?? {}) as Record<string, string>;
          if (!String(props["RpsTicket"] ?? "").startsWith("d=ms-at-")) { send(401, {}); return; }
          send(200, {
            Token: `xbl-user-${tokenSeq}`, NotAfter: new Date(Date.now() + 14 * 86_400_000).toISOString(),
            DisplayClaims: { xui: [{ uhs: "uhs-1" }] },
          });
          return;
        }
        case "xsts": {
          const rp = String(b["RelyingParty"] ?? "");
          const props = (b["Properties"] ?? {}) as { UserTokens?: string[] };
          if (!props.UserTokens?.[0]?.startsWith("xbl-user-")) { send(401, {}); return; }
          const xui: Record<string, string> = { uhs: "uhs-1" };
          if (rp === "http://xboxlive.com") { xui["xid"] = state.xuid; xui["gtg"] = state.gamertag; }
          send(200, {
            Token: `xsts|${rp}|${Date.now()}`, NotAfter: new Date(Date.now() + 16 * 3_600_000).toISOString(),
            DisplayClaims: { xui: [xui] },
          });
          return;
        }
        case "cdn": {
          const gt = path.split("/")[3] ?? "";
          send(state.taken.has(gt.toUpperCase()) || gt.toUpperCase() === state.gamertag.toUpperCase() ? 200 : 404, "");
          return;
        }
        case "policy": {
          if (!xstsOk) { send(401, {}); return; }
          const gt = String(b["gamertag"] ?? "").toUpperCase();
          if (state.taken.has(gt)) { send(409, {}); return; }
          send(200, {});
          return;
        }
        case "reserve": {
          if (!xstsOk) { send(401, { description: "Token audience is not valid for this service" }); return; }
          const gt = String(b["classicGamertag"] ?? "");
          const rid = String(b["reservationId"] ?? "");
          if (!gt || rid !== state.xuid) { send(400, { description: "Bad reservation request" }); return; }
          if (state.taken.has(gt.toUpperCase())) { send(409, { description: "Gamertag is not available" }); return; }
          state.reservations.set(gt.toUpperCase(), rid);
          send(200, { classicGamertag: gt, gamertag: gt, gamertagSuffix: "", modernGamertag: gt, uniqueModernGamertag: gt });
          return;
        }
        case "change": {
          if (!xstsOk) { send(401, {}); return; }
          const gt = String(b["gamertag"] ?? "");
          if (state.reservations.get(gt.toUpperCase()) !== state.xuid) { send(409, { description: "No reservation" }); return; }
          state.gamertag = gt;
          state.taken.add(gt.toUpperCase());
          send(200, { gamertag: gt, gamertagSuffix: "" });
          return;
        }
        default:
          send(404, { error: "mock: unknown route", path });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, get state() { return state; }, server, reset: () => { state = freshState(); } } as never);
    });
  });
}

// Standalone mode for end-to-end runs.
if (process.argv[1] && /mock-xbox\.ts$/.test(process.argv[1])) {
  const port = Number(process.env["MOCK_PORT"] ?? 4599);
  void startMockXbox(port).then(({ url }) => console.log(`mock xbox listening on ${url}`));
}

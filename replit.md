# Universal Checker (by sjaf)

A unified username/gamertag checking dashboard. Xbox is the first tool (formerly GTagHunter):
high-speed gamertag availability checks with Double Check and auto-claim. A Discord bot (`artifacts/discord-bot`) remains as a remote control. New platform checkers
are added to the sidebar in `components/app-shell.tsx` as they are integrated.

## App map

- Routes: `/xbox` (Checker), `/xbox/sniper` (Sniper), `/hits`, `/activity` (live activity), `/status` (system status), `/settings`
- Theme: black + gold (tokens in `artifacts/gamertag-finder/src/index.css`); logo in `public/logo*.svg`, `favicon.svg`, and `src/components/logo.tsx`
- Generation: a mode system (Basic, Pattern, Advanced, Input) in `lib/modes.ts` (UI) and `api-server/src/lib/gamertag-generator.ts` (engine). Xbox rules live in one place, `api-server/src/lib/xbox-validation.ts`: 3-15 characters, first character a letter, letters/numbers/single inner spaces only.
- A result is `available` + `alertable` only when the primary check says available and, with
  double check on, the secondary policy check returned exactly `approved`. Only alertable results
  reach the Discord webhook, auto-claim or the Discord bot. Policy failures become `unknown`.
- Discord webhook is configured in Settings and stored server-side (`artifacts/api-server/webhook.json`,
  git-ignored, never returned to the browser). `DISCORD_WEBHOOK_URL` is still honoured as a fallback.
- Live activity is a bounded in-memory log of real checks (`GET /api/activity`, SSE `/api/activity/stream`,
  `GET /api/activity?only=hits`). The session snapshot (`GET /api/gamertag/sessions/:id`) is authoritative
  and is polled by the UI; SSE is only a realtime enhancement.
- Claims: every claim (Hits button, Checker auto-claim, Sniper, Discord bot) goes through
  `api-server/src/lib/xbox-claim.ts`: reserve (`POST gamertag.xboxlive.com/gamertags/reserve`) then change
  (`POST accounts.xboxlive.com/users/current/profile/gamertag`, `{ gamertag, previewOnly: false,
  reservationId: <xuid> }`, contract version 3), authorized with the `http://xboxlive.com` XSTS token. **The
  URL and method are confirmed correct against live Xbox** (two earlier change-step guesses were ruled out
  first by live 404s and a 405). The success (200, claimed) path is NOT yet confirmed live — every live
  attempt so far has hit Xbox error code 1372 ("gamertag belongs to another user") on every tested string,
  which is either expected (Xbox's shared/discriminator gamertag system) or a sign the request body still
  needs work; see `.agents/memory/gamertag-autoclaim.md` for the open question and how to resolve it. Xbox
  error code 1372 is mapped to a plain-language explanation: the availability heuristics (CDN + reserve policy
  check) can say AVAILABLE for a tag the accounts service still considers taken; the change step is the only fully
  authoritative check, and only a genuinely free tag has actually exercised the success path so far.
  A claim is `claimed` only when Xbox's response names the exact tag, or a freshly issued XSTS token reports it.
  One claim runs at a time. Checker auto-claim runs server-side and stops after the first confirmed claim.
  Recent claim records: `GET /api/gamertag/claims`.
- Sniper: one target, server-side run (`api-server/src/lib/xbox-sniper.ts`), persisted to `sniper.json`
  (git-ignored) and resumed after a restart. `GET /api/xbox/sniper` (authoritative snapshot, polled),
  `POST /api/xbox/sniper/start|stop`, `PATCH /api/xbox/sniper/settings`, SSE `/api/xbox/sniper/stream`.
  Uses the Checker's availability checks (`lib/xbox-availability.ts`) including Double Check.
- System status: `GET /api/status` (real CDN probe and session counts; a service that can't be verified reports UNKNOWN).

## Stack

- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui (`artifacts/gamertag-finder`)
- **Backend**: Express + TypeScript (`artifacts/api-server`)
- **Database**: Replit PostgreSQL via Drizzle ORM (`lib/db`)
- **API contract**: OpenAPI spec + Orval codegen (`lib/api-spec`, `lib/api-client-react`)

## Running locally

Both services start automatically via configured workflows:
- **API Server** — `pnpm --filter @workspace/api-server run dev` (builds then starts on `$PORT`)
- **Frontend** — `pnpm --filter @workspace/gamertag-finder run dev` (Vite dev server on `$PORT`)

## Required environment variables

| Variable | Where | Notes |
|---|---|---|
| `XBOX_CLIENT_ID` | Shared env | Optional. Defaults to the "GT hinter" app registration; public identifier, not a secret |
| `XBOX_TENANT_ID` | Shared env | Optional. Defaults to `consumers` (needed for personal Microsoft accounts) |
| `API_PROXY_TARGET` | Frontend dev | Optional, e.g. `http://localhost:3001`; makes Vite forward `/api` when not behind a path router |
| `XBOX_REFRESH_TOKEN` | Secret | Xbox Live refresh token; obtained via in-app device code flow, then saved here to survive restarts |
| `SESSION_SECRET` | Secret | Express session signing secret |
| `DATABASE_URL` | Runtime-managed | Set automatically by Replit |

## Xbox authentication

The API uses Microsoft's device code flow (`artifacts/api-server/src/lib/xbox-auth.ts`):
1. Click **Connect Xbox** → the server requests a device code (scopes `XboxLive.signin offline_access openid profile email`)
2. Visit the URL shown and sign in on Microsoft's own page (MFA works as normal; the app never sees the password)
3. The server exchanges the token chain Microsoft → Xbox Live user token → XSTS (`http://xboxlive.com`) and reads
   the XUID + gamertag from the XSTS claims. The UI shows CONNECTED/NOT READY with the failing stage and reason
   (e.g. XErr 2148916233 "no Xbox profile"), a masked email, gamertag and masked XUID. `POST /api/auth/xbox/verify`
   re-runs the chain.
4. The refresh token is saved server-side in `.xbox-auth.json` (mode 0600, git-ignored); it is never logged or sent to the browser.

Without Xbox auth, the checker falls back to CDN-based availability checks (less accurate).

## Build & test

```bash
pnpm install
PORT=1 BASE_PATH=/ NODE_ENV=production pnpm build        # typecheck + all builds (vite config needs PORT/BASE_PATH)
pnpm --filter @workspace/api-server test                 # node:test suite against a local Xbox mock
bash packaging/linux-app/build-app.sh                    # or copy gamertag-finder/dist/public → api-server/dist/public
PORT=8080 NODE_ENV=production node artifacts/api-server/dist/index.mjs
```

`XBOX_MOCK_BASE` points every Microsoft/Xbox request at a local mock. It is for tests only (the server logs a warning).

## User preferences

- Keep the existing pnpm monorepo structure

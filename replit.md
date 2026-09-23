# Universal Checker (by sjaf)

A unified username/gamertag checking dashboard. Xbox is the first tool (formerly GTagHunter):
high-speed gamertag availability checks with Double Check and auto-claim. A Discord bot (`artifacts/discord-bot`) remains as a remote control. New platform checkers
are added to the sidebar in `components/app-shell.tsx` as they are integrated.

## App map

- Routes: `/xbox`, `/hits`, `/activity` (live activity), `/status` (system status), `/settings`
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
1. Click **Sign in to Xbox** in the UI → start device code flow
2. Visit the URL shown and enter the code on your Xbox/Microsoft account
3. Once authorized, the refresh token is printed to server logs — copy it into the `XBOX_REFRESH_TOKEN` secret so it survives restarts

Without Xbox auth, the checker falls back to CDN-based availability checks (less accurate).

## User preferences

- Keep the existing pnpm monorepo structure

---
name: Xbox Gamertag Checker Architecture
description: How the gamertag checker works — concurrency model, endpoint cascade, pause, clean chars
---

## Concurrency model
- N concurrent async workers where N = `rate` param (1–20)
- Each worker fires at most once/second → aggregate throughput = `rate` checks/sec
- Implemented in Node.js (user asked for asyncio/Semaphore; project is TypeScript — equivalent pattern used)
- Workers share a `tried: Set<string>` — synchronous has/add prevents duplicates without a mutex

## Endpoint strategy
- **Bulk search**: CDN only (`avatar-ssl.xboxlive.com/avatar/{gt}/avatar-body.png`). Fast, no rate limit. 200=taken, 401/404=available.
- **Single verify**: tries authenticated availability endpoint first, then CDN.
- `gamertag.xboxlive.com/gamertags/{gt}/availability` always 404s with relying party `http://xboxlive.com` — skipped in bulk mode to avoid wasted round-trip.
- `profile.xboxlive.com` intentionally NOT used — Retry-After 299s from Replit IPs.

**Why:** Skipping the always-404 availability endpoint in bulk mode roughly doubles effective CPS by halving the per-check request count.

## AbortSignal timing — critical
- `AbortSignal.timeout(N)` MUST be created AFTER `sem.acquire()`, not before.
- If created before, the semaphore wait time eats into the timeout budget. Xbox profile checks can take 6–8 s; combined with semaphore wait this caused near-100% "error" results.
- Per-check timeout: 15 s (inside semaphore, so full budget applies to the actual HTTP request).

## Worker startup stagger
- Workers are launched with a 200 ms stagger (index × 200 ms delay) to avoid initial burst.
- Simultaneous startup was causing Xbox to rate-limit the first 3–5 checks on every new session.

## Pause support
- `session.paused: boolean` field; workers poll every 250ms while paused
- Pause/Resume: POST `/api/gamertag/sessions/:id/pause` and `/resume` (no OpenAPI spec entry, called via raw fetch from frontend)

## Generation engine (`src/lib/gamertag-generator.ts`)
- A search body is `{ config: { mode, params }, rate, runEthanPolicyCheck }`. `compileGeneration(config)` validates every setting, rejects impossible configs with messages, proves the config can produce a name, then returns a generator. Finite sources (List, fixed patterns) end and the session becomes `completed`.
- Every emitted name has passed `validateXboxGamertag` (`src/lib/xbox-validation.ts`): 3-15 chars, first char a letter, only A-Z a-z 0-9 and single inner spaces. The workers check again before any Xbox request. Claim and verify routes use the same validator.
- Modes: random, letters, numbers (letter + digits), mixed, repetitive, sequential, alternating, mirrored, palindrome, grouped, block, pattern, combination, prefix, suffix, prefix_suffix, customizable, position, charset, vowel_consonant, word_number, number_affix, list. "Templates" is UI-only (presets).
- Word modes use the embedded word list (`src/lib/word-list.ts`) or user-supplied words.
- There is no clean-characters option; use Customizable > Remove / Shouldn't have to exclude characters.
- Endpoints: `POST /api/gamertag/config/validate` (config check), `POST /api/gamertag/validate` (username check).

## Auto-claim suffix rejection
- Claim route checks Xbox's response body for returned `gamertag`/`Gamertag` field.
- If the assigned tag != requested tag (Xbox added suffix), returns HTTP 409 `suffix_assigned` and does NOT accept the claim.
- Tries XUID-scoped URL first (`/users/xuid({xuid})/gamertags/{gt}`), falls back to bare `/gamertags/{gt}`.
- XUID extracted from XSTS `DisplayClaims.xui[0].xid` and stored in auth cache.

## CPS tracking
- `session.recentCheckTs: number[]` — rolling 5-second window timestamps
- Computed by `computeCps()` on each SSE result event; attached to result payload as `cps`
- Frontend displays `isRunning ? rate : 0` as CPS (simpler than reading from SSE for the dashboard)

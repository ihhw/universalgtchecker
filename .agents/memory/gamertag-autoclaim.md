---
name: Gamertag Auto-Claim Endpoint
description: How claiming works (reserve → change with the xboxlive.com XSTS token), and the change endpoints/methods already ruled out by live testing
---

## Flow (lib/xbox-claim.ts — the only claim path)
1. `POST https://gamertag.xboxlive.com/gamertags/reserve` `{ classicGamertag, reservationId: <xuid>, targetGamertagFields: "classicGamertag" }`
   — **CONFIRMED against live Xbox**: this call is accepted (reserve succeeds; the account's own auth/XUID chain is correct).
2. `POST https://accounts.xboxlive.com/users/current/profile/gamertag` `{ gamertag, previewOnly: false }`, `x-xbl-contract-version: 3`
   — current best guess. **Not yet confirmed against live Xbox** — PUT to this same URL got HTTP 405 (see below),
   which proves the URL is right and only the method/body needs fixing.

Both use `Authorization: XBL3.0 x={uhs};{xsts}` where the XSTS relying party is `http://xboxlive.com`.

## Endpoints/methods already ruled out by real testing — do not reintroduce
- `PUT gamertag.xboxlive.com/users/xuid({xuid})/gamertag` — confirmed **HTTP 404** against live Xbox
  (user report, 2026-09-23: reserve succeeded in 2214ms, then this URL 404'd). This was the very first guess.
- `PUT accounts.xboxlive.com/users/current/profile/gamertag` — confirmed **HTTP 405** against live Xbox
  (user report, 2026-09-23, reserve 2150-2223ms then this 405'd in 308-1278ms). 405 means the URL itself
  is right, just not this HTTP method. **The code now reads and surfaces Xbox's `Allow` response header on
  405** (see `xbox-claim.ts`, the `cs === 405` branch) — the very next 405, if any, will report in the UI
  exactly which methods Xbox accepts there, e.g. "it accepts: GET, PATCH". Check that field first before
  guessing further.
- The original pre-fix code sent an `http://accounts.xboxlive.com`-scoped XSTS token to `gamertag.xboxlive.com`
  (wrong audience → 401/403) and PUT to other guessed URLs with no reservation at all. Browser-side auto-claim
  also claimed every hit and only ran with the tab open.

If POST also turns out wrong: check the Allow header from the 405 first (it's now captured automatically and
shown in the claim result — no more guessing which method). If Allow says PATCH, switch `method` in the
`send(CHANGE_URL, ...)` call in `xbox-claim.ts` to `"PATCH"`. Other things to try after that: contract version
`2` instead of `3`, or a body shaped `{ Gamertag, PreviewOnly }` (capitalized keys, matching older Xbox API
conventions). Get the exact response (status + body + any Allow header) from the user before guessing again —
Xbox's error body usually names the real reason too (e.g. code 1441 = no free gamertag change left on the
account).

## Success rule
CLAIMED only when the change response names the exact tag with no suffix, or a force-refreshed XSTS `gtg` claim equals the tag. 2xx without proof → UNKNOWN. 405 → UNKNOWN immediately (no identity re-check needed; the request never reached Xbox's handler). 5xx/timeout at change → confirm via identity before deciding. One claim at a time (global lock).

## Uncertainty
These endpoints are those of Xbox's own apps' gamertag-change flow, not officially documented by Microsoft, and
Xbox itself is unreachable from the dev sandbox (network policy blocks `*.xboxlive.com`), so behaviour here is
tested against `test/mock-xbox.ts`, not live Xbox. The reserve step is the one piece confirmed live so far, by
the user's own test runs; the change step has had two guesses ruled out live (404, then 405) and is now on its
third attempt (POST, same URL as the 405 one).

---
name: Gamertag Auto-Claim Endpoint
description: How claiming works — reserve → change, BOTH steps now confirmed correct against live Xbox
---

## Flow (lib/xbox-claim.ts — the only claim path) — CONFIRMED against live Xbox end-to-end
1. `POST https://gamertag.xboxlive.com/gamertags/reserve` `{ classicGamertag, reservationId: <xuid>, targetGamertagFields: "classicGamertag" }`
   — reserve succeeds (user reports, 2026-09-23, multiple runs).
2. `POST https://accounts.xboxlive.com/users/current/profile/gamertag` `{ gamertag, previewOnly: false }`, `x-xbl-contract-version: 3`
   — **CONFIRMED as the right URL, method and body shape** (user report, 2026-09-23): Xbox now returns real
   business-logic responses from it (structured `{ source, code, description, data, traceInformation }` JSON on
   400), not routing errors. Do not change this URL/method/body again without a new, concrete failure to react to.

Both use `Authorization: XBL3.0 x={uhs};{xsts}` where the XSTS relying party is `http://xboxlive.com`.

## What's actually still unverified — and an open red flag
Whether a *genuinely available* gamertag produces a **200** success response with the exact tag echoed back.
Every live test so far has gotten code 1372 ("belongs to another user") — **five different test strings in a
row**, including unusual ones like "snowefjajs" and "snowefj". That many consecutive identical rejections is
suspicious enough to flag explicitly rather than assume it's coincidence:
- **Plausible innocent explanation**: Xbox now lets many accounts share the same *classic* (display) gamertag,
  disambiguated by a hidden suffix/discriminator. That means far more strings are "already in use" as someone's
  display name than the old one-gamertag-per-string model would suggest, so short/plausible-looking test strings
  colliding repeatedly is more likely than it sounds.
- **Plausible bug explanation**: the change request isn't correctly linked to the reservation made in step 1, so
  Xbox runs a broader/different collision check than the one the reservation actually passed.
- **Response to the bug explanation (2026-09-23)**: added `reservationId: <xuid>` to the change request body
  (same field/value used at reserve time), on the theory that the two steps need to be explicitly linked. This
  is a reasoned guess, not a confirmed fix — it has NOT been tested live yet.
- **The one test that actually distinguishes these two explanations**: have the user attempt the exact same
  rename through Xbox's own official UI (the Xbox app, or account.xbox.com → profile → customize gamertag) for
  one of the strings that failed here. If Xbox's own UI also rejects it as taken, the innocent explanation is
  confirmed and this endpoint is done. If Xbox's own UI succeeds, the request body still needs work — try
  without `reservationId` again (rule that variable back out) or try PascalCase keys (`Gamertag`,
  `PreviewOnly`, `ReservationId`) next, informed by whatever exact body the user reports back.

## Xbox accounts-service error codes seen live (ACCOUNTS_ERROR map in xbox-claim.ts)
- **1372** = "The gamertag belongs to another user" — the classic (undiscriminated) gamertag string is already
  someone's live current gamertag. Mapped to `errorCode: "taken"` with a plain-language reason. This is a real,
  correct rejection, not a bug: it means the Checker's availability signal (CDN avatar existence + the
  `user.mgt.xboxlive.com/gamertags/reserve` policy check) gave a false "available" for this specific tag.
  **This is a known, expected gap** — those two signals are heuristics; the accounts-service change endpoint is
  Xbox's only fully authoritative check, and it only runs at claim time. Do not try to "fix" this by tightening
  the availability heuristics without evidence of a systemic false-positive rate; a single miss on a short/common
  test string (e.g. "uhh9", "snox", "testikencs") is expected, not a defect.
  When testing manually, prefer targets independently confirmed free (not just Checker-reported AVAILABLE) to
  exercise the actual-success path.

## Endpoints/methods already ruled out by real testing — do not reintroduce
- `PUT gamertag.xboxlive.com/users/xuid({xuid})/gamertag` — confirmed **HTTP 404** against live Xbox.
- `PUT accounts.xboxlive.com/users/current/profile/gamertag` — confirmed **HTTP 405** (Allow header reading is
  kept in the code as defence in depth in case this ever changes again, but POST is now confirmed correct).
- The original pre-fix code sent an `http://accounts.xboxlive.com`-scoped XSTS token to `gamertag.xboxlive.com`
  (wrong audience → 401/403) and PUT to other guessed URLs with no reservation at all. Browser-side auto-claim
  also claimed every hit and only ran with the tab open.

## Success rule
CLAIMED only when the change response names the exact tag with no suffix, or a force-refreshed XSTS `gtg` claim equals the tag. 2xx without proof → UNKNOWN. 405 → UNKNOWN immediately (no identity re-check needed). 5xx/timeout at change → confirm via identity before deciding. One claim at a time (global lock).

## Uncertainty
The endpoints are Xbox's own apps' gamertag-change flow, not officially documented by Microsoft. Xbox itself is
unreachable from the dev sandbox (network policy blocks `*.xboxlive.com`), so all automated tests here run
against `test/mock-xbox.ts`; the URL/method/error-code facts above come from the user's own live test runs, not
from the dev sandbox.

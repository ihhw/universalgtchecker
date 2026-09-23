---
name: Gamertag Auto-Claim Endpoint
description: How claiming works — reserve step confirmed live; change step's URL/method confirmed live, request-body shape still being narrowed down
---

## Flow (lib/xbox-claim.ts — the only claim path)
1. `POST https://gamertag.xboxlive.com/gamertags/reserve` `{ classicGamertag, reservationId: <xuid>, targetGamertagFields: "classicGamertag" }`
   — **CONFIRMED against live Xbox**: reserve succeeds (user reports, 2026-09-23, many runs).
2. `POST https://accounts.xboxlive.com/users/current/profile/gamertag` `{ Gamertag, PreviewOnly: false, ReservationId: <xuid> }`, `x-xbl-contract-version: 3`
   — **URL and method CONFIRMED against live Xbox.** Body shape is on its 3rd live iteration — see the timeline
   below. Current body is PascalCase, informed directly by evidence (not a blind guess). **Not yet confirmed to
   actually perform the rename** — see "What's still open" below before changing this again.

Both use `Authorization: XBL3.0 x={uhs};{xsts}` where the XSTS relying party is `http://xboxlive.com`.

## Live testing timeline for the change-step body (2026-09-23, all same user/account)
1. Body `{ gamertag, previewOnly: false }` (no reservation link) → **every single tested string** (uhh9, snox,
   testikencs, snowefj, snowefjajs — 5 in a row) got **HTTP 400, code 1372 "The gamertag belongs to another
   user"**. Five in a row on short/unusual strings was suspicious enough to treat as a probable bug, not
   coincidence.
2. Added `reservationId: <xuid>` (still lowercase `gamertag`/`previewOnly`) → **the exact same target
   (`snowefjajs`) that had 400'd three times in a row immediately got a real HTTP 200** on the next attempt.
   This is strong, concrete evidence that linking the reservation was the fix for the 1372 problem — treat that
   as settled; do not remove `ReservationId` again without new contrary evidence.
3. But that 200's body was `{"hasFree":true}` — no gamertag confirmation, and a subsequent forced XSTS
   re-issue showed the account's `gtg` claim was still the OLD gamertag ("Y1vv"). The claim engine correctly
   detected this (no false CLAIMED) and reported `UNKNOWN`. This reads as Xbox answering an eligibility/preview
   question, not performing the write — consistent with `gamertag`/`previewOnly` (lowercase) not being the
   fields Xbox's schema actually expects, so it silently defaulted to a no-op/preview response. Switched the
   whole body to PascalCase (`Gamertag`, `PreviewOnly`, `ReservationId`) on the theory that Xbox's schema here
   is consistently cased (matching the auth-flow JSON bodies elsewhere, which are all PascalCase) — **NOT yet
   tested live.**

## What's still open
Whether the PascalCase body (step 3 above) actually performs the rename. The next live test result is the
thing to react to:
- **200 with the exact gamertag echoed back** (or a `gtg` XSTS claim that now matches) → CLAIMED, done, no
  further guessing needed.
- **200 with `{"hasFree":true}` again, unconfirmed by identity** → PascalCase wasn't the missing piece either.
  Next things to try, in order: (a) capture the full response headers, not just the body — Xbox sometimes
  signals real vs. preview via a header rather than the body; (b) try `Preview: false` instead of
  `PreviewOnly: false` as the field name; (c) consider whether a *separate* follow-up call is needed to commit
  after this "eligibility" response (i.e. this might genuinely be a legitimate 2-phase eligibility→commit flow,
  not a naming bug at all) — if so, the commit call's shape needs to be found some other way, since guessing
  blind here has a real cost (each guess burns one of the account's live free-gamertag-change attempts if it
  ever *does* commit unexpectedly).
- **A different status/body entirely** → capture it verbatim and treat as new information, same as before.

**Important cost consideration**: unlike checks, each change attempt is a real write attempt against a real
Xbox account. If a body shape unexpectedly succeeds, it consumes the account's free gamertag change. Prefer
narrow, well-reasoned adjustments over broad guessing sprees, and get the exact response back before trying
the next variant.

## Xbox accounts-service error codes seen live (ACCOUNTS_ERROR map in xbox-claim.ts)
- **1372** = "The gamertag belongs to another user". Historically this fired on *every* tested string before
  `ReservationId` was added (see timeline above) — that pattern turned out to be explained by the missing
  reservation link, not by Xbox's shared/discriminator gamertag system being unusually strict. Still mapped to
  `errorCode: "taken"` with a plain-language reason for the case where it's a genuine collision, which is
  expected to still happen sometimes now that the reservation link is fixed.

## Endpoints/methods/bodies already ruled out by real testing — do not reintroduce
- `PUT gamertag.xboxlive.com/users/xuid({xuid})/gamertag` — confirmed **HTTP 404** against live Xbox.
- `PUT accounts.xboxlive.com/users/current/profile/gamertag` — confirmed **HTTP 405** (Allow header reading is
  kept in the code as defence in depth in case this ever changes again).
- `POST` to the accounts URL with a lowercase body and no `ReservationId` — reliably 400s with code 1372 on
  every target (see timeline above).
- `POST` to the accounts URL with a lowercase body and `reservationId` added — gets HTTP 200 but does not
  actually apply the change (see timeline above); superseded by the current PascalCase body.
- The original pre-fix code sent an `http://accounts.xboxlive.com`-scoped XSTS token to `gamertag.xboxlive.com`
  (wrong audience → 401/403) and PUT to other guessed URLs with no reservation at all. Browser-side auto-claim
  also claimed every hit and only ran with the tab open.

## Success rule
CLAIMED only when the change response names the exact tag with no suffix, or a force-refreshed XSTS `gtg` claim equals the tag. 2xx without proof → UNKNOWN. 405 → UNKNOWN immediately (no identity re-check needed). 5xx/timeout at change → confirm via identity before deciding. One claim at a time (global lock). This safety rule is doing real work: it's what caught the "hasFree" false-200 in step 3 above and prevented it being reported as a successful claim.

## Uncertainty
The endpoints are Xbox's own apps' gamertag-change flow, not officially documented by Microsoft. Xbox itself is
unreachable from the dev sandbox (network policy blocks `*.xboxlive.com`), so all automated tests here run
against `test/mock-xbox.ts`; the URL/method/body/error-code facts above come from the user's own live test
runs, not from the dev sandbox.

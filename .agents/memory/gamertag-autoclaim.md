---
name: Gamertag Auto-Claim Endpoint
description: Reserve + change URL/method/body all confirmed live; the open question is now account/app authorization (HTTP 403 code 5025), not request format
---

## Flow (lib/xbox-claim.ts — the only claim path)
1. `POST https://gamertag.xboxlive.com/gamertags/reserve` `{ classicGamertag, reservationId: <xuid>, targetGamertagFields: "classicGamertag" }`
   — **CONFIRMED against live Xbox**: reserve succeeds (user reports, 2026-09-23, many runs).
2. `POST https://accounts.xboxlive.com/users/current/profile/gamertag` `{ Gamertag, PreviewOnly: false, ReservationId: <xuid> }`, `x-xbl-contract-version: 3`
   — **URL, method AND body shape now CONFIRMED against live Xbox** (the PascalCase body got past the
   "hasFree"-preview problem — see timeline). **What is NOT yet confirmed is that a successful write ever
   completes** — every live attempt with the correct body has instead hit HTTP 403 code 5025, which looks like
   an account/app-authorization gate, not a request-format problem. See "What's still open" below.

Both use `Authorization: XBL3.0 x={uhs};{xsts}` where the XSTS relying party is `http://xboxlive.com`.

## Live testing timeline for the change-step body (2026-09-23, all same user/account)
1. Body `{ gamertag, previewOnly: false }` (lowercase, no reservation link) → **every tested string** (uhh9,
   snox, testikencs, snowefj, snowefjajs — 5 in a row) got **HTTP 400, code 1372** "The gamertag belongs to
   another user".
2. Added `reservationId: <xuid>` (still lowercase) → the exact same target (`snowefjajs`) that had 400'd three
   times in a row immediately got a real HTTP 200. **Confirms `ReservationId` links the reservation — settled,
   keep it.**
3. That 200's body was `{"hasFree":true}` — no gamertag confirmation, and a forced XSTS re-issue showed the
   account's `gtg` claim unchanged. Read as Xbox answering an eligibility/preview question, not performing the
   write.
4. Switched the whole body to PascalCase (`Gamertag`, `PreviewOnly`, `ReservationId`) → **on the next live
   attempt this got past the "hasFree" preview response entirely** — now hitting HTTP 403 with a different,
   structured Xbox error (see next point), which is real business-logic processing, not a schema/casing
   rejection. **PascalCase confirmed correct — settled, keep it.**
5. Current live blocker: **HTTP 403, `{"source":"Accounts","code":5025,"description":"<a GUID>","data":null}`**.
   Fired on two different, unrelated target gamertags (`kcidpwdv`, `nea3kftv`) — not correlated with the target
   name at all (unlike 1372), and the `description` field is literally a GUID rather than human-readable text,
   which is a different character of error than 1372's plain-English one.

## What's still open
Code 5025 is the live blocker. Two honest, undistinguished hypotheses — **do not guess further into the
request body for this one; it doesn't look like a body-format problem**:
- (a) **This Xbox account has no free gamertag change available right now** — could be already used, account
  age/region restrictions, or similar. Checkable directly: does the official Xbox app / account.xbox.com show
  a free gamertag change available for this account?
- (b) **This app's OAuth registration (client_id `94028da3-aa0c-4c46-b5ec-ac40baaba225`, "GT hinter") is not
  authorized to perform gamertag *changes***, even though the same token scope (`XboxLive.signin
  offline_access`) is enough to sign in and reserve names. Some Xbox account-mutation operations may be
  restricted to Microsoft's own first-party apps. If true, this would be a hard architectural limit, not
  something fixable by adjusting the request — no amount of guessing headers/fields would get past it.
- **The test that distinguishes them**: have the user attempt an actual rename through Xbox's own official
  app/website for one of the failing targets. If Xbox's own app also can't do it right now → (a), confirmed,
  nothing left to fix here. If Xbox's own app succeeds → (b) is likely, and this needs new information (not
  guessing) about what makes an app "authorized" for this operation before touching the code again.
- If the user reports that the official Xbox app CAN successfully change gamertag, that changes the situation
  meaningfully — come back to this file and don't assume the previous "settled" facts still fully explain
  things; re-open the investigation with that new information.

**Cost note, still applies**: each change attempt is a real write attempt against a real account. A 403 is a
clean no-op (nothing applied), but don't multiply guesses without new evidence — get the exact response back
each time.

## Xbox accounts-service error codes seen live (ACCOUNTS_ERROR map in xbox-claim.ts)
- **1372** ("The gamertag belongs to another user", HTTP 400) — fired on *every* tested string before
  `ReservationId` was added; explained by the missing reservation link, not by unusual collision rates. Still
  mapped to `errorCode: "taken"` for the case where it's a genuine collision (expected to still happen
  sometimes now that the reservation link is fixed).
- **5025** (HTTP 403, `description` is a GUID) — see "What's still open" above. Mapped to `errorCode:
  "not_allowed"` with an explanation covering both hypotheses; do not narrow this message to just one
  explanation until the manual Xbox-app test above has actually distinguished them.

## Endpoints/methods/bodies already ruled out by real testing — do not reintroduce
- `PUT gamertag.xboxlive.com/users/xuid({xuid})/gamertag` — confirmed **HTTP 404**.
- `PUT accounts.xboxlive.com/users/current/profile/gamertag` — confirmed **HTTP 405** (Allow header reading
  kept as defence in depth).
- `POST` to the accounts URL, lowercase body, no `ReservationId` — reliably 400s code 1372 on every target.
- `POST` to the accounts URL, lowercase body + `reservationId` — HTTP 200 but does not apply the change
  (reads as a preview/eligibility answer).
- The original pre-fix code sent an `http://accounts.xboxlive.com`-scoped XSTS token to `gamertag.xboxlive.com`
  (wrong audience → 401/403) and PUT to other guessed URLs with no reservation at all. Browser-side auto-claim
  also claimed every hit and only ran with the tab open.

## Success rule
CLAIMED only when the change response names the exact tag with no suffix, or a force-refreshed XSTS `gtg` claim equals the tag. 2xx without proof → UNKNOWN. 405 → UNKNOWN immediately (no identity re-check needed). 5xx/timeout at change → confirm via identity before deciding. One claim at a time (global lock). This rule is doing real work: it's what caught the "hasFree" false-200 (timeline step 3) and correctly reported UNKNOWN instead of a false CLAIMED.

## Uncertainty
The endpoints are Xbox's own apps' gamertag-change flow, not officially documented by Microsoft. Xbox itself is
unreachable from the dev sandbox (network policy blocks `*.xboxlive.com`), so all automated tests here run
against `test/mock-xbox.ts`; the URL/method/body/error-code facts above come from the user's own live test
runs, not from the dev sandbox. The success (200, actually-applied) path has still never been observed live.

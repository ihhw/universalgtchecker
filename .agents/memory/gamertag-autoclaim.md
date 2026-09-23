---
name: Gamertag Auto-Claim Endpoint
description: Full reserve->change flow CONFIRMED working end-to-end against live Xbox (2026-09-23). Remaining known issue was a false-UNKNOWN timing race, now fixed with retries.
---

## Flow (lib/xbox-claim.ts — the only claim path) — CONFIRMED end-to-end against live Xbox
1. `POST https://gamertag.xboxlive.com/gamertags/reserve` `{ classicGamertag, reservationId: <xuid>, targetGamertagFields: "classicGamertag" }`
2. `POST https://accounts.xboxlive.com/users/current/profile/gamertag` `{ Gamertag, PreviewOnly: false, ReservationId: <xuid> }`, `x-xbl-contract-version: 3`

Both use `Authorization: XBL3.0 x={uhs};{xsts}` where the XSTS relying party is `http://xboxlive.com`.

**2026-09-23: a live claim through this app actually renamed the user's Xbox account.** The full chain — sign-in,
reserve, change, confirmation — is confirmed working. Do not re-litigate the URL/method/body of either step
without new, concrete evidence (a real error response) — see the ruled-out list below for what NOT to try again.

## The one remaining bug found live, now fixed: confirmation timing race
The change step succeeded and the account's gamertag genuinely changed, but the app reported `UNKNOWN`
("...did not confirm the new gamertag...") instead of `CLAIMED`. Root cause: `accounts.xboxlive.com` (where the
change is applied) and `xsts.auth.xboxlive.com` (which is what `confirmViaIdentity()` asks to verify the
account's current gamertag) are separate Xbox services. A change accepted by the former can take a few seconds
to become visible to the latter. The code only checked once, immediately, and gave up.

**Fix**: `confirmViaIdentity()` in `xbox-claim.ts` now retries up to 3 times with short pauses (1.5s, 2s, 2.5s —
~6s total worst case) before concluding a change wasn't applied. Covered by a new test
("change applied but the identity service lags a few seconds...") that simulates the account's gamertag only
updating 3s after the change response, and asserts the claim still ends up `CLAIMED` via `confirmedBy:
"xsts_identity"`.

If UNKNOWN/unconfirmed results are ever reported again despite the gamertag actually having changed, the
retry budget (`CONFIRM_RETRY_DELAYS_MS`) may need to be longer — check the reported latency first; don't assume
it's a new bug without checking whether propagation just took longer than ~6s this time.

## Live testing timeline for the change-step body (2026-09-23, all same user/account)
1. Body `{ gamertag, previewOnly: false }` (lowercase, no reservation link) → every tested string got HTTP 400,
   code 1372 "The gamertag belongs to another user".
2. Added `reservationId: <xuid>` (still lowercase) → got past 1372, but the 200 response body was
   `{"hasFree":true}` with no gamertag confirmation — an apparent eligibility/preview answer, not a write.
3. Switched the whole body to PascalCase (`Gamertag`, `PreviewOnly`, `ReservationId`) → got past the "hasFree"
   preview response; Xbox began returning real business-logic responses.
4. Hit HTTP 403 code 5025 (`description` was a GUID) on two different, unrelated targets — looked like an
   account/app-authorization gate.
5. **User manually renamed their account through the official Xbox app to confirm their account DOES have a
   free change available** — this succeeded, which is why subsequent attempts through this app started
   returning real success responses instead of 5025 (once a real free change is available, the app can use it
   too; 5025 was very likely "no free change available on the account", not an app-permission restriction).
6. A subsequent claim through this app (Sniper) actually renamed the account, but was reported as `UNKNOWN` due
   to the confirmation-timing race described above. Fixed with the retry loop.

## Xbox accounts-service error codes seen live (ACCOUNTS_ERROR map in xbox-claim.ts)
- **1372** ("The gamertag belongs to another user", HTTP 400) — genuine per-target collision, OR (historically)
  a missing `ReservationId` link, which is now always sent. Mapped to `errorCode: "taken"`.
- **5025** (HTTP 403, `description` is a GUID) — most likely means the account has no free gamertag change
  available right now (see timeline step 5 above, which supports this reading over the app-authorization
  hypothesis, though it isn't 100% certain since both could be simultaneously true in general). Mapped to
  `errorCode: "not_allowed"` with an explanation covering both possibilities.

## Endpoints/methods/bodies already ruled out by real testing — do not reintroduce
- `PUT gamertag.xboxlive.com/users/xuid({xuid})/gamertag` — confirmed **HTTP 404**.
- `PUT accounts.xboxlive.com/users/current/profile/gamertag` — confirmed **HTTP 405** (Allow header reading
  kept as defence in depth).
- `POST` to the accounts URL, lowercase body, no `ReservationId` — reliably 400s code 1372 on every target.
- `POST` to the accounts URL, lowercase body + `reservationId` — HTTP 200 but does not apply the change (reads
  as a preview/eligibility answer).
- The original pre-fix code sent an `http://accounts.xboxlive.com`-scoped XSTS token to `gamertag.xboxlive.com`
  (wrong audience → 401/403) and PUT to other guessed URLs with no reservation at all. Browser-side auto-claim
  also claimed every hit and only ran with the tab open.

## Success rule
CLAIMED only when the change response names the exact tag with no suffix, or a force-refreshed XSTS `gtg` claim equals the tag (now retried up to ~6s to allow for propagation lag — see above). 2xx without proof and no eventual identity match → UNKNOWN. 405 → UNKNOWN immediately (no identity re-check needed). 5xx/timeout at change → confirm via identity (with the same retries) before deciding. One claim at a time (global lock). This rule caught two real false-positive risks live: the "hasFree" preview 200, and the confirmation-timing race — both correctly reported as not-yet-confirmed rather than a false CLAIMED, and the second one is now fixed by retrying instead of giving up.

## Uncertainty
The endpoints are Xbox's own apps' gamertag-change flow, not officially documented by Microsoft. Xbox itself is
unreachable from the dev sandbox (network policy blocks `*.xboxlive.com`), so all automated tests here run
against `test/mock-xbox.ts`; the URL/method/body/error-code/timing facts above come from the user's own live
test runs, not from the dev sandbox. The success path IS now confirmed live (see top of file).

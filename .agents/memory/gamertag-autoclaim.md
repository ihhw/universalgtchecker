---
name: Gamertag Auto-Claim Endpoint
description: How claiming works (reserve → change with the xboxlive.com XSTS token) and why the old claim never worked
---

## Flow (lib/xbox-claim.ts — the only claim path)
1. `POST https://gamertag.xboxlive.com/gamertags/reserve` `{ classicGamertag, reservationId: <xuid>, targetGamertagFields: "classicGamertag" }`
2. `POST https://gamertag.xboxlive.com/users/xuid(<xuid>)/gamertag` `{ reservationId: <xuid>, gamertag: { gamertag, gamertagSuffix: "", classicGamertag }, preview: false, useLegacyEntitlement: false }`
Both with `Authorization: XBL3.0 x={uhs};{xsts}` where the XSTS relying party is `http://xboxlive.com`, and `x-xbl-contract-version: 1`.

**Why:** the old code sent an `http://accounts.xboxlive.com` XSTS token to gamertag.xboxlive.com (tokens are audience-bound → 401/403) and PUT to guessed URLs with no reservation. Browser-side auto-claim also claimed every hit and only ran with the tab open.

## Success rule
CLAIMED only when the change response names the exact tag with no suffix, or a force-refreshed XSTS `gtg` claim equals the tag. 2xx without proof → UNKNOWN. 5xx/timeout at change → confirm via identity before deciding. One claim at a time (global lock).

## Uncertainty
These endpoints are those of Xbox's web gamertag-change flow, not officially documented. They could not be exercised against live Xbox from the dev sandbox (xboxlive.com blocked); behaviour was tested against test/mock-xbox.ts.

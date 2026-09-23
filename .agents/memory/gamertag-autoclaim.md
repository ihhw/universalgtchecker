---
name: Gamertag Auto-Claim Endpoint
description: How the auto-claim feature works; Xbox API endpoint used; known uncertainty
---

## Endpoint
`POST /api/gamertag/claim` — proxied through the API server to avoid CORS

Backend makes: `PUT https://gamertag.xboxlive.com/gamertags/{gamertag}` with auth header

**Why proxied:** Direct browser requests would hit CORS; also keeps token handling server-side per request.

## Auth header format
- Accept full pre-formatted `XBL3.0 x={userHash};{xstsToken}` OR raw token
- If raw token: builds `XBL3.0 x={userHash ?? "*"};{xstsToken}`
- `userHash` is optional; `*` works for some endpoints but not all

## Known uncertainty
The Xbox gamertag claim endpoint (`PUT gamertag.xboxlive.com/gamertags/{gt}`) is based on observed Xbox app traffic — not official docs. May require XUID-based routing in some cases. Error shapes are explicit (`rate_limited`, `auth_failed`, `rejected`, `xbox_error`, `network_error`) for easy frontend display.

## Error shapes returned
```json
{ "success": false, "error": "rate_limited|auth_failed|rejected|xbox_error|network_error", "message": "...", "gamertag": "..." }
```

## Frontend integration
- `claimStatuses: Map<string, ClaimStatus>` in home.tsx state
- Per-card `Claim` button visible only when `xstsToken` is set
- Auto-claim fires on each new available tag when `autoClaimEnabled && xstsToken`
- Discord webhook fires on each new available tag when `webhookEnabled && webhookUrl`

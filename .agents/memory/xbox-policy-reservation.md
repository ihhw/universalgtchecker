---
name: Xbox Policy Reservation
description: Reservation ID behavior for the optional Xbox reserve policy check
---

The Xbox reserve policy endpoint can use the authenticated account’s XUID as its reservationId after the XSTS exchange completes. Keep this value server-side and prefer it for signed-in users; retain an environment override only for legacy or special account flows.

**Why:** EthanC’s archived checker describes reservationId as a separate captured credential, but the account/Xbox API flow already exposes the XUID needed by the reserve request. Asking users to paste tokens or IDs into the browser is unnecessary and unsafe.

**How to apply:** Resolve the XUID after obtaining the server-side XBL authorization header, then send it in the reserve payload for the optional policy check.
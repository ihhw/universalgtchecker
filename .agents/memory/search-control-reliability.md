---
name: Search control reliability
description: Reliability rule for continuous gamertag search progress and controls
---

Treat SSE as a real-time enhancement, not the only source of truth. Search clients should poll the session snapshot as a fallback so attempts, results, pause, resume, and cancellation remain visible when a long-lived stream is interrupted.

**Why:** The API workers can continue scanning successfully while a browser or Discord stream is disconnected, which makes the product appear stuck and can leave users unable to tell whether stop or pause took effect.

**How to apply:** Keep session state authoritative on the API; use bounded result history and periodic status polling in every control surface that relies on a long-running search.
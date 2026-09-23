---
name: Ethan approval gate
description: Secondary Xbox policy behavior for available gamertag alerts
---

When Ethan's secondary check is enabled, a primary availability result is not alertable unless the secondary policy response is `approved`. Auth, rate-limit, unavailable, and network outcomes must be withheld from available alerts.

**Why:** Treating a failed or incomplete double-check as available defeats the purpose of the safety control and can send tags that Xbox will reject.

**How to apply:** Keep the policy result on the emitted record for transparency, but gate the alertable `available` status on approval.
---
name: Discord result delivery
description: Delivery behavior for long-running Discord search notifications
---

Pass the command's successful interaction follow-up into long-running slash-command watchers instead of assuming the bot can call `channel.send()`. Treat Discord HTTP delivery failures as non-fatal to the Xbox search.

**Why:** A command can be acknowledged through an interaction while ordinary channel sends return 403 Missing Access; letting that exception escape makes a healthy search appear to stop.

**How to apply:** Preserve the API session as the source of truth, use safe notification wrappers, and ensure the bot has View Channel and Send Messages permissions for ongoing alerts beyond the interaction follow-up lifetime.
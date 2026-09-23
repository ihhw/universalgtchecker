---
name: Discord command permissions
description: Discord gateway intent requirements for the GTagHunter control bot
---

Use slash commands as the default Discord control surface. Prefix commands beginning with `!` require Message Content Intent in the Discord Developer Portal and should remain opt-in.

**Why:** Discord rejects the bot at gateway login when it requests the privileged intent without the application setting enabled, preventing all commands from running.

**How to apply:** Keep `DISCORD_ENABLE_PREFIX_COMMANDS` unset or false for a bot that should connect with ordinary intents; enable it only after the Discord application has Message Content Intent enabled.
# Universal Checker: Discord remote-control bot

This bot is a thin Discord control plane for the existing GTagHunter API. It
uses `discord.py` and `aiohttp`, so the Xbox auth, worker pool, persistence,
and claim logic stay in the API server instead of being duplicated.

## Setup

Set these environment variables:

- `DISCORD_BOT_TOKEN` — store this as a server secret. Never commit it or paste it into chat; if it is ever exposed, reset it in the Discord Developer Portal.
- `DISCORD_CHANNEL_ID` — optional numeric channel ID. When set, commands and
  alerts are restricted to that channel.
- `GAMERTAG_API_URL` — optional API base URL; defaults to
  `http://127.0.0.1:8080/api`.

Slash commands (`/start`, `/stop`, `/status`, `/check_gt`, and so on) work
without privileged intents and are the recommended control surface. If you
also want the legacy `!start` / `!stop` prefix aliases, open the Discord
Developer Portal, go to **Bot → Privileged Gateway Intents**, enable **Message
Content Intent**, save, and set `DISCORD_ENABLE_PREFIX_COMMANDS=true`.

Run it with:

```bash
python3 artifacts/discord-bot/bot.py
```

Commands:

- `!start [3L|4L|5L|3C|4C|5C|COMMON|WORDS] [rate]`
- `!add_list <format> [rate]` (alias for `!start`)
- `!stop`
- `!pause` / `!resume`
- `!status`
- `!check_gt <tag>`
- `!claim <tag>`

Searches are intentionally infinite. `!stop` is the explicit stop command.

The bot sends a heartbeat to the API every 30 seconds so **System status** in the web app can show whether it is online. Without a heartbeat the app reports it as unknown.
The bot posts every newly found available tag to the same channel and logs
the event to stdout.
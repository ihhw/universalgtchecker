#!/usr/bin/env bash
# Sets up the Discord remote-control bot as a background service, so it stays
# running the same way the main app does. Run install.sh first.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." &>/dev/null && pwd)"
BOT_DIR="$PROJECT_ROOT/artifacts/discord-bot"
APP_ID="universal-checker"
PORT="${UNIVERSAL_CHECKER_PORT:-8080}"

BOT_ENV_FILE="$HOME/.config/universal-checker/bot.env"
SYSTEMD_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$SYSTEMD_DIR/$APP_ID-bot.service"

echo "== Universal Checker — Discord bot install =="

if [ ! -f "$BOT_ENV_FILE" ]; then
  echo
  echo "No bot token file found at:"
  echo "  $BOT_ENV_FILE"
  echo
  echo "Create it first — get a token from https://discord.com/developers/applications"
  echo "(Bot -> Reset Token), never paste it into a chat, then run:"
  echo
  echo "  mkdir -p \"$(dirname "$BOT_ENV_FILE")\""
  echo "  nano \"$BOT_ENV_FILE\""
  echo
  echo "and put one line in it:"
  echo "  DISCORD_BOT_TOKEN=your_new_token_here"
  echo
  echo "then:"
  echo "  chmod 600 \"$BOT_ENV_FILE\""
  echo
  echo "and run this script again."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 was not found. Install it (e.g. 'sudo apt install python3 python3-venv') and re-run this script." >&2
  exit 1
fi

echo "==> Setting up the bot's Python environment"
if [ ! -d "$BOT_DIR/.venv" ]; then
  python3 -m venv "$BOT_DIR/.venv"
fi
"$BOT_DIR/.venv/bin/pip" install --quiet --upgrade pip
"$BOT_DIR/.venv/bin/pip" install --quiet -r "$BOT_DIR/requirements.txt"

echo "==> Installing the background service"
mkdir -p "$SYSTEMD_DIR"
sed \
  -e "s#__BOT_DIR__#$BOT_DIR#g" \
  -e "s#__BOT_ENV_FILE__#$BOT_ENV_FILE#g" \
  -e "s#__PORT__#$PORT#g" \
  "$SCRIPT_DIR/universal-checker-bot.service.template" > "$UNIT_FILE"

systemctl --user daemon-reload
systemctl --user enable "$APP_ID-bot.service" >/dev/null
systemctl --user restart "$APP_ID-bot.service"

echo
echo "Bot service installed and started. It will also start automatically at login."
echo
echo "Useful commands:"
echo "  systemctl --user status  $APP_ID-bot.service"
echo "  systemctl --user restart $APP_ID-bot.service   # after changing the token"
echo "  journalctl --user -u $APP_ID-bot.service -f"
echo
echo "Give it a minute, then check the System status page in the app — the"
echo "Discord bot row should turn online once it has sent its first heartbeat."

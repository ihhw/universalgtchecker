#!/usr/bin/env bash
# Removes everything install.sh and install-bot.sh set up. Your project
# source folder (wherever you unzipped it) is not touched or deleted.
set -euo pipefail

APP_ID="universal-checker"
INSTALL_DIR="$HOME/.local/share/$APP_ID"
DESKTOP_FILE="$HOME/.local/share/applications/$APP_ID.desktop"
SYSTEMD_DIR="$HOME/.config/systemd/user"

echo "== Universal Checker — uninstall =="

for unit in "$APP_ID.service" "$APP_ID-bot.service"; do
  if systemctl --user list-unit-files "$unit" >/dev/null 2>&1; then
    systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
  fi
  rm -f "$SYSTEMD_DIR/$unit"
done
systemctl --user daemon-reload || true

rm -f "$DESKTOP_FILE"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true

rm -rf "$INSTALL_DIR"

echo "Removed the service, desktop icon and installed app files."
echo
echo "Left untouched:"
echo "  - Your project source folder (wherever you unzipped it)"
echo "  - $HOME/.config/universal-checker/bot.env (your Discord bot token, if you set one up)"
echo "  - Anything saved in the browser (Hits, Settings, templates), since that lives in the browser you used, not on the server"
echo
echo "Delete the bot token file too if you want a completely clean removal:"
echo "  rm -rf \"$HOME/.config/universal-checker\""

#!/usr/bin/env bash
# Installs Universal Checker as a Linux desktop app:
#   - a background service (systemd --user) that keeps the server running,
#     starting automatically each time you log in
#   - an icon in your application menu that opens it in a browser window
#
# Safe to re-run after pulling in code changes: it rebuilds and restarts the
# service without touching your saved Xbox sign-in or webhook settings.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." &>/dev/null && pwd)"

APP_NAME="Universal Checker"
APP_ID="universal-checker"
PORT="${UNIVERSAL_CHECKER_PORT:-8080}"

INSTALL_DIR="$HOME/.local/share/$APP_ID"
APP_DIR="$INSTALL_DIR/app"     # replaced on every install/update
DATA_DIR="$INSTALL_DIR/data"   # kept across installs: sign-in, webhook, session state
BIN_DIR="$INSTALL_DIR/bin"
ICON_PATH="$INSTALL_DIR/icon.png"
DESKTOP_FILE="$HOME/.local/share/applications/$APP_ID.desktop"
SYSTEMD_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$SYSTEMD_DIR/$APP_ID.service"

echo "== $APP_NAME — install =="
echo "Source:  $PROJECT_ROOT"
echo "Target:  $INSTALL_DIR"
echo "Port:    $PORT  (change with UNIVERSAL_CHECKER_PORT=... before running this script)"
echo

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd was not found. This installer needs systemd (present on Ubuntu, Fedora, Debian, Arch and most others)." >&2
  exit 1
fi

echo "==> Building the app"
"$SCRIPT_DIR/build-app.sh"
API_DIST="$PROJECT_ROOT/artifacts/api-server/dist"

echo
echo "==> Installing files to $INSTALL_DIR"
mkdir -p "$DATA_DIR" "$BIN_DIR" "$(dirname "$DESKTOP_FILE")" "$SYSTEMD_DIR"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$API_DIST/." "$APP_DIR/"
cp "$PROJECT_ROOT/artifacts/gamertag-finder/public/favicon-256.png" "$ICON_PATH"

cat > "$BIN_DIR/run-server.sh" <<EOF
#!/usr/bin/env bash
# Used by the systemd service. Safe to run by hand too, for debugging:
#   $BIN_DIR/run-server.sh
set -euo pipefail
cd "$DATA_DIR"
export NODE_ENV=production
export PORT="\${PORT:-$PORT}"
exec node "$APP_DIR/index.mjs"
EOF
chmod +x "$BIN_DIR/run-server.sh"

cat > "$BIN_DIR/open-app.sh" <<EOF
#!/usr/bin/env bash
# Used by the desktop icon. Makes sure the background service is running,
# then opens the app. Prefers a Chromium-based browser's "app mode" (a plain
# window, no tabs or address bar); falls back to your default browser.
set -euo pipefail
PORT="$PORT"
URL="http://127.0.0.1:\$PORT/"

systemctl --user is-active --quiet $APP_ID.service || systemctl --user start $APP_ID.service

for _ in \$(seq 1 30); do
  if command -v curl >/dev/null 2>&1; then
    curl -fs -o /dev/null "\$URL" && break
  fi
  sleep 0.3
done

for browser in google-chrome-stable google-chrome chromium chromium-browser brave-browser microsoft-edge-stable microsoft-edge; do
  if command -v "\$browser" >/dev/null 2>&1; then
    "\$browser" --app="\$URL" >/dev/null 2>&1 &
    disown
    exit 0
  fi
done

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "\$URL" >/dev/null 2>&1 &
  disown
  exit 0
fi

if command -v firefox >/dev/null 2>&1; then
  firefox --new-window "\$URL" >/dev/null 2>&1 &
  disown
fi
EOF
chmod +x "$BIN_DIR/open-app.sh"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=Xbox gamertag checker
Exec=$BIN_DIR/open-app.sh
Icon=$ICON_PATH
Terminal=false
Categories=Network;Utility;
StartupWMClass=$APP_NAME
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true

sed \
  -e "s#__DATA_DIR__#$DATA_DIR#g" \
  -e "s#__BIN_DIR__#$BIN_DIR#g" \
  -e "s#__PORT__#$PORT#g" \
  "$SCRIPT_DIR/universal-checker.service.template" > "$UNIT_FILE"

echo
echo "==> Starting the background service"
systemctl --user daemon-reload
systemctl --user enable "$APP_ID.service" >/dev/null
systemctl --user restart "$APP_ID.service"

READY=0
for _ in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1 && curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/status"; then
    READY=1
    break
  fi
  sleep 0.3
done

echo
if [ "$READY" = "1" ]; then
  echo "The server is up on port $PORT."
else
  echo "The server didn't answer yet. Check its status with:"
  echo "  systemctl --user status $APP_ID.service"
  echo "  journalctl --user -u $APP_ID.service -e"
fi

echo
echo "'$APP_NAME' now appears in your application menu and starts automatically"
echo "each time you log in."
echo
echo "To also have it running right after boot, even before you log in, run:"
echo "  loginctl enable-linger \$USER"
echo
echo "Useful commands:"
echo "  systemctl --user status  $APP_ID.service"
echo "  systemctl --user restart $APP_ID.service"
echo "  journalctl --user -u $APP_ID.service -f"
echo
echo "To set up the optional Discord remote-control bot as a service too, run:"
echo "  $SCRIPT_DIR/install-bot.sh"
echo

read -r -p "Open $APP_NAME now? [Y/n] " REPLY || REPLY="y"
case "$REPLY" in
  [nN]*) ;;
  *) "$BIN_DIR/open-app.sh" >/dev/null 2>&1 & disown ;;
esac

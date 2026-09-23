#!/usr/bin/env bash
# Builds an installable .deb: a real desktop app you open like Firefox —
# double-click it (or `sudo apt install ./the-file.deb`), an icon appears in
# your application menu, and it opens in its own window, not a browser tab.
#
# This still has to be built on your machine, the same as before: the build
# needs to download this project's dependencies (pnpm install), which needs
# internet access that isn't available in the environment this was written
# in. Once built, though, the .deb it produces is a normal, self-contained,
# installable package — copy it, share it, install it on another machine
# with the same Ubuntu version, exactly like any other .deb you'd download.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." &>/dev/null && pwd)"

PKG_NAME="universal-checker"
VERSION="${UNIVERSAL_CHECKER_VERSION:-1.0.0}"
ARCH="all"

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "dpkg-deb was not found. Install it with: sudo apt install dpkg-dev" >&2
  exit 1
fi

echo "==> Building the app"
"$PROJECT_ROOT/packaging/linux-app/build-app.sh"
API_DIST="$PROJECT_ROOT/artifacts/api-server/dist"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ROOT="$WORK/$PKG_NAME"

echo
echo "==> Staging the package"
mkdir -p "$ROOT/DEBIAN"
mkdir -p "$ROOT/opt/$PKG_NAME/app" "$ROOT/opt/$PKG_NAME/bin"
mkdir -p "$ROOT/usr/share/applications"
mkdir -p "$ROOT/usr/share/icons/hicolor/256x256/apps"

cp -r "$API_DIST/." "$ROOT/opt/$PKG_NAME/app/"
cp "$SCRIPT_DIR/universal-checker-launcher.py" "$ROOT/opt/$PKG_NAME/bin/universal-checker"
chmod 755 "$ROOT/opt/$PKG_NAME/bin/universal-checker"
cp "$PROJECT_ROOT/artifacts/gamertag-finder/public/favicon-256.png" \
  "$ROOT/usr/share/icons/hicolor/256x256/apps/universal-checker.png"

cat > "$ROOT/usr/share/applications/$PKG_NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Universal Checker
Comment=Xbox gamertag checker
Exec=/opt/$PKG_NAME/bin/universal-checker
Icon=universal-checker
Terminal=false
Categories=Network;Utility;
EOF

cp "$SCRIPT_DIR/control" "$ROOT/DEBIAN/control"
sed -i \
  -e "s/^Version:.*/Version: $VERSION/" \
  -e "s/^Architecture:.*/Architecture: $ARCH/" \
  "$ROOT/DEBIAN/control"
cp "$SCRIPT_DIR/postinst" "$ROOT/DEBIAN/postinst"
cp "$SCRIPT_DIR/postrm" "$ROOT/DEBIAN/postrm"
chmod 755 "$ROOT/DEBIAN/postinst" "$ROOT/DEBIAN/postrm"

OUT="$PROJECT_ROOT/${PKG_NAME}_${VERSION}_${ARCH}.deb"
echo
echo "==> Building the package"
dpkg-deb --build --root-owner-group "$ROOT" "$OUT"

echo
echo "Built: $OUT"
echo
echo "Install it with:"
echo "  sudo apt install \"$OUT\""
echo "('apt install ./file.deb' — not 'dpkg -i' — so any missing dependency,"
echo " like the WebKit GTK library, is fetched automatically.)"
echo
echo "Or open your file manager, find the .deb, and double-click it if your"
echo "desktop offers a package-installer window for .deb files."

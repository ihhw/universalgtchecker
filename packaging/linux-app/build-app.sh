#!/usr/bin/env bash
# Builds a self-contained copy of Universal Checker: one bundled server file
# (artifacts/api-server/dist/index.mjs) plus the built frontend next to it
# (artifacts/api-server/dist/public/). After this script, the app can be run
# anywhere with only Node.js installed — no pnpm, no node_modules needed:
#
#   PORT=8080 NODE_ENV=production node artifacts/api-server/dist/index.mjs
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." &>/dev/null && pwd)"
cd "$PROJECT_ROOT"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not found on PATH. Install it first (see the project README), then re-run this script." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node was not found on PATH. Install Node.js 20.3 or newer, then re-run this script." >&2
  exit 1
fi

echo "==> Installing dependencies"
pnpm install

echo "==> Building the frontend"
# PORT/BASE_PATH are required by vite.config.ts even for a one-shot build; the
# value of PORT is not used once built (the app is served by the API server).
PORT=1 BASE_PATH=/ NODE_ENV=production \
  pnpm --filter @workspace/gamertag-finder run build

echo "==> Building the API server"
pnpm --filter @workspace/api-server run build

echo "==> Assembling the self-contained app"
API_DIST="$PROJECT_ROOT/artifacts/api-server/dist"
FRONTEND_DIST="$PROJECT_ROOT/artifacts/gamertag-finder/dist/public"
rm -rf "$API_DIST/public"
cp -r "$FRONTEND_DIST" "$API_DIST/public"

echo
echo "Build complete: $API_DIST"
echo "  index.mjs  - the bundled server"
echo "  public/    - the built web app, served by the server"
echo
echo "Run it directly with:"
echo "  PORT=8080 NODE_ENV=production node \"$API_DIST/index.mjs\""

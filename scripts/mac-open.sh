#!/bin/bash
# Open Video Repair on macOS. Uses the Node and FFmpeg shipped in vendor/
# when this folder came from the GitHub zip. Otherwise uses what is installed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

case "$(uname -m)" in
  arm64) VENDOR="$ROOT/vendor/darwin-arm64" ;;
  *) VENDOR="$ROOT/vendor/darwin-x64" ;;
esac

if [ -x "$VENDOR/node" ]; then
  xattr -cr "$VENDOR" 2>/dev/null || true
  export PATH="$VENDOR:/usr/bin:/bin"
  export FFMPEG_PATH="$VENDOR/ffmpeg"
  export FFPROBE_PATH="$VENDOR/ffprobe"
  exec "$VENDOR/node" "$ROOT/scripts/launch.js" --detach
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Node.js required" message "Install Node.js 18 or newer from https://nodejs.org" as critical' || true
  exit 1
fi

exec node "$ROOT/scripts/launch.js" --detach

#!/bin/zsh
# Build the Mac and Windows zips people download from GitHub.
# Vendor binaries stay inside the zip. This folder keeps using your installed Node and FFmpeg.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d /tmp/video-repair-package.XXXXXX)"
NAME="Video Repair"
OUT_DIR="$ROOT/dist"
ZIP_MAC="$OUT_DIR/Video-Repair-macOS.zip"
ZIP_WIN="$OUT_DIR/Video-Repair-windows.zip"

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

chmod +x "$ROOT/scripts/fetch_vendor.sh" "$ROOT/scripts/build_app.sh" "$ROOT/scripts/mac-open.sh"
"$ROOT/scripts/build_app.sh"

copy_app_files() {
  local dest="$1"
  mkdir -p "$dest/scripts" "$dest/server" "$dest/public"
  rsync -a --delete --exclude '.DS_Store' "$ROOT/scripts/" "$dest/scripts/"
  rsync -a --delete --exclude '.DS_Store' "$ROOT/server/" "$dest/server/"
  rsync -a --delete --exclude '.DS_Store' "$ROOT/public/" "$dest/public/"
  rsync -a --delete --exclude '.DS_Store' "$ROOT/node_modules/" "$dest/node_modules/"
  cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/README.md" "$ROOT/LICENSE" "$dest/"
  rm -rf "$dest/data" "$dest/temp" "$dest/dist" "$dest/vendor"
}

DEST_MAC="$STAGE/mac/$NAME"
mkdir -p "$DEST_MAC"
copy_app_files "$DEST_MAC"
rsync -a --delete --exclude '.DS_Store' "$ROOT/Video Repair.app" "$DEST_MAC/"
cp "$ROOT/Open Video Repair.command" "$DEST_MAC/Open Video Repair.command"
cp "$ROOT/Fix macOS warning.command" "$DEST_MAC/Fix macOS warning.command"
chmod +x \
  "$DEST_MAC/Open Video Repair.command" \
  "$DEST_MAC/Fix macOS warning.command" \
  "$DEST_MAC/scripts/mac-open.sh" \
  "$DEST_MAC/Video Repair.app/Contents/MacOS/VideoRepair"

echo "Fetching Mac Node and FFmpeg…"
"$ROOT/scripts/fetch_vendor.sh" "$DEST_MAC/vendor" darwin-arm64 darwin-x64
cp "$DEST_MAC/vendor/THIRD_PARTY.txt" "$DEST_MAC/THIRD_PARTY.txt"
xattr -cr "$DEST_MAC" 2>/dev/null || true

mkdir -p "$OUT_DIR"
rm -f "$ZIP_MAC"
ditto -c -k --sequesterRsrc --keepParent "$DEST_MAC" "$ZIP_MAC"
xattr -cr "$ZIP_MAC" 2>/dev/null || true

DEST_WIN="$STAGE/win/$NAME"
mkdir -p "$DEST_WIN"
copy_app_files "$DEST_WIN"
cp "$ROOT/Open Video Repair.bat" "$DEST_WIN/Open Video Repair.bat"
rm -rf "$DEST_WIN/Video Repair.app"
rm -f "$DEST_WIN/Open Video Repair.command" "$DEST_WIN/Fix macOS warning.command"
rm -rf "$DEST_WIN/scripts/native" "$DEST_WIN/scripts/build_app.sh" "$DEST_WIN/scripts/mac-open.sh"

echo "Fetching Windows Node and FFmpeg…"
"$ROOT/scripts/fetch_vendor.sh" "$DEST_WIN/vendor" win-x64
cp "$DEST_WIN/vendor/THIRD_PARTY.txt" "$DEST_WIN/THIRD_PARTY.txt"

rm -f "$ZIP_WIN"
ditto -c -k --keepParent "$DEST_WIN" "$ZIP_WIN"
xattr -cr "$ZIP_WIN" 2>/dev/null || true

echo "Packed $ZIP_MAC ($(stat -f%z "$ZIP_MAC") bytes)"
echo "Packed $ZIP_WIN ($(stat -f%z "$ZIP_WIN") bytes)"

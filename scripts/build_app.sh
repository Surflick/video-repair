#!/bin/zsh
# Rebuild Video Repair.app so Finder can launch it on Apple Silicon and Intel.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/Video Repair.app"
MACOS="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"
SRC="$ROOT/scripts/launcher.c"
OUT="$MACOS/VideoRepair.new"

echo "Building $APP"
mkdir -p "$MACOS" "$RES"

if clang -arch arm64 -arch x86_64 -o "$OUT" "$SRC" 2>/dev/null; then
  echo "Universal launcher."
else
  echo "Universal build unavailable. Building for this Mac."
  clang -arch "$(uname -m)" -o "$OUT" "$SRC"
fi
chmod +x "$OUT"
rm -f "$MACOS/VideoRepair"
mv "$OUT" "$MACOS/VideoRepair"

ICON_SRC="$ROOT/build/AppIcon.icns"
if [[ -f "$ICON_SRC" ]]; then
  cp "$ICON_SRC" "$RES/AppIcon.icns"
fi

cat > "$APP/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Video Repair</string>
  <key>CFBundleExecutable</key>
  <string>VideoRepair</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.surflick.videorepair</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Video Repair</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.2.0</string>
  <key>CFBundleVersion</key>
  <string>1.2.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

echo -n "APPL????" > "$APP/Contents/PkgInfo"
chmod +x "$ROOT/scripts/mac-open.sh" "$ROOT/Open Video Repair.command"
codesign --force --deep -s - "$APP" 2>/dev/null || true
xattr -cr "$APP" 2>/dev/null || true
echo "Done: $APP"

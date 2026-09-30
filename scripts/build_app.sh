#!/bin/zsh
# Build Video Repair.app as a native Mac app: its own window (WebKit), Dock icon
# and menus. It starts the bundled repair engine privately on 127.0.0.1 and stops
# it on quit. No browser needed, works offline. Universal (Apple Silicon + Intel).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/Video Repair.app"
MACOS="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"
SRC="$ROOT/scripts/native/VideoRepairApp.swift"
OUT="$(mktemp -d /tmp/video-repair-build.XXXXXX)"
trap 'rm -rf "$OUT"' EXIT

# Oldest macOS the app supports. Always pass an explicit target: building
# without one defaults to the build Mac's own macOS, and the app then refuses
# to open on anything older.
MINOS=11.3

echo "Building $APP (macOS $MINOS+)"
mkdir -p "$MACOS" "$RES"

if xcrun swiftc -O -target "arm64-apple-macos$MINOS" -o "$OUT/arm64" "$SRC" \
   && xcrun swiftc -O -target "x86_64-apple-macos$MINOS" -o "$OUT/x86_64" "$SRC"; then
  lipo -create -output "$OUT/VideoRepair" "$OUT/arm64" "$OUT/x86_64"
  echo "Universal app."
else
  echo "Universal build unavailable. Building for this Mac."
  ARCH=x86_64; [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == "1" ]] && ARCH=arm64
  xcrun swiftc -O -target "$ARCH-apple-macos$MINOS" -o "$OUT/VideoRepair" "$SRC"
fi
cp "$OUT/VideoRepair" "$MACOS/VideoRepair"
chmod +x "$MACOS/VideoRepair"

ICON_SRC="$ROOT/build/AppIcon.icns"
if [[ -f "$ICON_SRC" ]]; then
  cp "$ICON_SRC" "$RES/AppIcon.icns"
fi

cat > "$APP/Contents/Info.plist" << PLIST
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
  <string>$MINOS</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

echo -n "APPL????" > "$APP/Contents/PkgInfo"
chmod +x "$ROOT/scripts/mac-open.sh" "$ROOT/Open Video Repair.command"
codesign --force --deep -s - "$APP" 2>/dev/null || true
xattr -cr "$APP" 2>/dev/null || true
echo "Done: $APP"

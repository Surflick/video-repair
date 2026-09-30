#!/bin/zsh
# Download portable Node, ffmpeg, and ffprobe.
# Usage: fetch_vendor.sh DEST [darwin-arm64|darwin-x64|win-x64]...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-}"
if [[ -z "$DEST" ]]; then
  echo "usage: fetch_vendor.sh DEST PLATFORM [PLATFORM...]" >&2
  exit 1
fi
shift
PLATFORMS=("$@")
if [[ ${#PLATFORMS[@]} -eq 0 ]]; then
  echo "usage: fetch_vendor.sh DEST PLATFORM [PLATFORM...]" >&2
  exit 1
fi

NODE_VER="v24.21.0"
FFMPEG_TAG="b6.1.1"
CACHE="$ROOT/temp/vendor-cache"
mkdir -p "$CACHE" "$DEST"

download() {
  local url="$1"
  local out="$2"
  if [[ -f "$out" && -s "$out" ]]; then
    echo "cached $(basename "$out")"
    return 0
  fi
  echo "downloading $(basename "$out")…"
  curl -fL --retry 3 --retry-delay 2 -o "${out}.part" "$url"
  mv "${out}.part" "$out"
}

extract_node_unix() {
  local tarball="$1"
  local bin_out="$2"
  if [[ -x "$bin_out" ]]; then
    return 0
  fi
  local tmp found
  tmp="$(mktemp -d "$CACHE/extract.XXXXXX")"
  tar -xzf "$tarball" -C "$tmp"
  found="$(find "$tmp" -type f -path '*/bin/node' | head -n 1)"
  if [[ -z "$found" ]]; then
    echo "node binary missing in $tarball" >&2
    rm -rf "$tmp"
    exit 1
  fi
  mkdir -p "$(dirname "$bin_out")"
  cp "$found" "$bin_out"
  chmod +x "$bin_out"
  rm -rf "$tmp"
}

extract_node_win() {
  local zipfile="$1"
  local bin_out="$2"
  if [[ -f "$bin_out" ]]; then
    return 0
  fi
  local tmp found
  tmp="$(mktemp -d "$CACHE/extract.XXXXXX")"
  ditto -x -k "$zipfile" "$tmp"
  found="$(find "$tmp" -type f -name 'node.exe' | head -n 1)"
  if [[ -z "$found" ]]; then
    echo "node.exe missing in $zipfile" >&2
    rm -rf "$tmp"
    exit 1
  fi
  mkdir -p "$(dirname "$bin_out")"
  cp "$found" "$bin_out"
  rm -rf "$tmp"
}

copy_exec() {
  mkdir -p "$(dirname "$2")"
  cp "$1" "$2"
  chmod +x "$2"
}

sign_mac() {
  codesign --force -s - "$1" 2>/dev/null || true
  xattr -cr "$1" 2>/dev/null || true
}

for plat in "${PLATFORMS[@]}"; do
  echo "vendor $plat → $DEST/$plat"
  mkdir -p "$DEST/$plat"
  case "$plat" in
    darwin-arm64|darwin-x64)
      download "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-${plat}.tar.gz" \
        "$CACHE/node-${NODE_VER}-${plat}.tar.gz"
      extract_node_unix "$CACHE/node-${NODE_VER}-${plat}.tar.gz" "$CACHE/node-${plat}"
      copy_exec "$CACHE/node-${plat}" "$DEST/$plat/node"

      download "https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffmpeg-${plat}" \
        "$CACHE/ffmpeg-${plat}"
      download "https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffprobe-${plat}" \
        "$CACHE/ffprobe-${plat}"
      copy_exec "$CACHE/ffmpeg-${plat}" "$DEST/$plat/ffmpeg"
      copy_exec "$CACHE/ffprobe-${plat}" "$DEST/$plat/ffprobe"
      sign_mac "$DEST/$plat/node"
      sign_mac "$DEST/$plat/ffmpeg"
      sign_mac "$DEST/$plat/ffprobe"
      ;;
    win-x64)
      download "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-win-x64.zip" \
        "$CACHE/node-${NODE_VER}-win-x64.zip"
      extract_node_win "$CACHE/node-${NODE_VER}-win-x64.zip" "$CACHE/node-win-x64.exe"
      cp "$CACHE/node-win-x64.exe" "$DEST/$plat/node.exe"

      download "https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffmpeg-win32-x64" \
        "$CACHE/ffmpeg-win32-x64"
      download "https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffprobe-win32-x64" \
        "$CACHE/ffprobe-win32-x64"
      cp "$CACHE/ffmpeg-win32-x64" "$DEST/$plat/ffmpeg.exe"
      cp "$CACHE/ffprobe-win32-x64" "$DEST/$plat/ffprobe.exe"
      ;;
    *)
      echo "unknown platform: $plat" >&2
      exit 1
      ;;
  esac
done

cat > "$DEST/THIRD_PARTY.txt" << 'EOF'
Video Repair ships these tools so you do not have to install anything else.

Node.js
  License: MIT
  https://nodejs.org

ffmpeg / ffprobe
  Builds from https://github.com/eugeneware/ffmpeg-static
  FFmpeg: LGPL/GPL — https://ffmpeg.org
  These static builds typically include GPL components.

Express
  License: MIT
  https://expressjs.com
EOF

echo "vendor ready in $DEST"

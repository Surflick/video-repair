#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
xattr -cr "$DIR" 2>/dev/null || true
osascript -e 'display notification "You can open Video Repair now" with title "Video Repair"' || true
open "$DIR/Video Repair.app"

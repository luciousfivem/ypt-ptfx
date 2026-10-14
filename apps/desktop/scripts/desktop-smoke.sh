#!/bin/bash
# Manual smoke test of the REAL desktop app (release build, embedded frontend, production CSP) on Linux.
#
# Scenarios (SCENARIO=...):
#   preset (default)  clicks "Purple Flames", opens Export and presses "Build export", then saves screenshots.
#                     With the converter bridge configured, the last screenshot must show "Export complete ...
#                     CodeWalker ... loaded the binary YPT (RSC7 ...)".
#   video             presses Import, types the path of VIDEO=/path/to/clip.mp4 into the native file dialog and
#                     screenshots the result: FFmpeg extraction -> keyed 4x4 atlas in the Sprite Editor.
#
#   pnpm --filter @vfxforge/desktop exec tauri build --no-bundle
#   VFXFORGE_BRIDGE_DLL=/path/to/vfxforge-ypt-bridge.dll \
#     xvfb-run -a -s "-screen 0 1600x960x24" apps/desktop/scripts/desktop-smoke.sh out-dir
#
# Needs: xvfb, xdotool, ImageMagick (`import`). Coordinates assume a 1600x960 screen.
set -euo pipefail
OUT="${1:-smoke-out}"; mkdir -p "$OUT"
BIN="${VFXFORGE_BIN:-$(dirname "$0")/../../../target/release/vfxforge-desktop}"
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1
HOME_DIR="$(mktemp -d)"; export XDG_DATA_HOME="$HOME_DIR/data" XDG_CONFIG_HOME="$HOME_DIR/config"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/dev.vfxforge.studio"
if [ -n "${VFXFORGE_BRIDGE_DLL:-}" ]; then
  printf '{"dll":"%s"}' "$VFXFORGE_BRIDGE_DLL" > "$XDG_CONFIG_HOME/dev.vfxforge.studio/tools.json"
fi
"$BIN" > "$OUT/app.log" 2>&1 &
APP=$!
trap 'kill $APP 2>/dev/null || true; rm -rf "$HOME_DIR"' EXIT
sleep 14;                                  import -window root "$OUT/01-start.png"
if [ "${SCENARIO:-preset}" = "video" ]; then
  : "${VIDEO:?set VIDEO=/absolute/path/to/clip.mp4}"
  xdotool mousemove 366 21 click 1;  sleep 4;  import -window root "$OUT/02-file-dialog.png"  # Import
  xdotool key ctrl+l; sleep 1                                                                 # GTK: type a path
  xdotool type --delay 40 "$VIDEO"; sleep 1; xdotool key Return
  sleep 20;                                    import -window root "$OUT/03-imported.png"
else
  xdotool mousemove 85 300 click 1;  sleep 12; import -window root "$OUT/02-preset.png"      # Purple Flames
  xdotool mousemove 1457 21 click 1; sleep 4;  import -window root "$OUT/03-export.png"      # Export
  xdotool mousemove 445 641 click 1; sleep 30; import -window root "$OUT/04-result.png"      # Build export
fi
echo "screenshots in $OUT"

#!/usr/bin/env bash
set -euo pipefail

# Generate a multi-bitrate DASH stream with numbered white frames on black bg.
# Usage: bash e2e/generate-dash-fixture.sh [output-dir]
# Falls back to $DASH_FIXTURE_DIR env var if no argument given.

OUT_DIR="${1:-${DASH_FIXTURE_DIR:-}}"
if [ -z "$OUT_DIR" ]; then
  echo "Usage: $0 <output-dir>  (or set DASH_FIXTURE_DIR)" >&2
  exit 1
fi

# Normalize Windows backslashes to forward slashes
OUT_DIR="${OUT_DIR//\\//}"

mkdir -p "$OUT_DIR"

DURATION=60
FPS=30
SOURCE="$OUT_DIR/source_1080p.mp4"

# --- Cross-platform font detection ---
OS="$(uname -s)"
case "$OS" in
  Linux*)
    FONT_OPT="fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
    ;;
  Darwin*)
    FONT_OPT="fontfile=/System/Library/Fonts/Menlo.ttc"
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    # On Windows, use font family name to avoid path colon issues
    FONT_OPT="font=Consolas"
    ;;
  *)
    echo "Warning: unknown OS '$OS', trying fontfile=DejaVuSansMono.ttf" >&2
    FONT_OPT="fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
    ;;
esac

echo "==> Generating 1080p source with frame counter ($DURATION s @ $FPS fps)..."
ffmpeg -y -loglevel error \
  -f lavfi -i "color=c=black:s=1920x1080:d=$DURATION:r=$FPS" \
  -vf "drawtext=${FONT_OPT}:fontsize=120:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:text='%{eif\:n\:d\:4}'" \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -g "$FPS" -keyint_min "$FPS" \
  -pix_fmt yuv420p \
  "$SOURCE"

echo "==> Packaging as DASH with 5 renditions..."
ffmpeg -y -loglevel error \
  -i "$SOURCE" \
  -filter_complex "\
    [0:v]split=5[v1][v2][v3][v4][v5];\
    [v1]scale=1920:1080[out1];\
    [v2]scale=1280:720[out2];\
    [v3]scale=854:480[out3];\
    [v4]scale=640:360[out4];\
    [v5]scale=426:240[out5]\
  " \
  -map "[out1]" -c:v:0 libx264 -b:v:0 3000k -preset ultrafast -g "$FPS" -keyint_min "$FPS" \
  -map "[out2]" -c:v:1 libx264 -b:v:1 1500k -preset ultrafast -g "$FPS" -keyint_min "$FPS" \
  -map "[out3]" -c:v:2 libx264 -b:v:2 500k  -preset ultrafast -g "$FPS" -keyint_min "$FPS" \
  -map "[out4]" -c:v:3 libx264 -b:v:3 400k  -preset ultrafast -g "$FPS" -keyint_min "$FPS" \
  -map "[out5]" -c:v:4 libx264 -b:v:4 300k  -preset ultrafast -g "$FPS" -keyint_min "$FPS" \
  -use_timeline 1 -use_template 1 \
  -seg_duration 2 \
  -adaptation_sets "id=0,streams=v" \
  -f dash "$OUT_DIR/manifest.mpd"

# Cleanup intermediate source
rm -f "$SOURCE"

echo "==> DASH fixture ready in $OUT_DIR"
ls -lh "$OUT_DIR"

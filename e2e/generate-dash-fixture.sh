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

echo "==> Generating 1080p source with frame counter and audio ($DURATION s @ $FPS fps)..."
ffmpeg -y -loglevel error \
  -f lavfi -i "color=c=black:s=1920x1080:d=$DURATION:r=$FPS" \
  -f lavfi -i "sine=frequency=440:duration=$DURATION:sample_rate=44100" \
  -vf "drawtext=${FONT_OPT}:fontsize=120:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:text='%{eif\:n\:d\:4}'" \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -g "$FPS" -keyint_min "$FPS" \
  -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  "$SOURCE"

echo "==> Packaging as DASH with 5 video renditions + audio..."
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
  -map 0:a -c:a aac -b:a 128k \
  -use_timeline 1 -use_template 1 \
  -seg_duration 2 \
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -f dash "$OUT_DIR/manifest.mpd"

# Cleanup intermediate source
rm -f "$SOURCE"

echo "==> Plaintext DASH fixture ready in $OUT_DIR"
ls -lh "$OUT_DIR"

# --- Encrypted DASH via Shaka Packager ---

if ! command -v packager &>/dev/null; then
  echo "==> Skipping encrypted fixture: 'packager' (Shaka Packager) not in PATH"
  exit 0
fi

echo "==> Generating encrypted DASH fixture..."

ENCRYPTED_DIR="$OUT_DIR/encrypted"
mkdir -p "$ENCRYPTED_DIR"

# Fixed ClearKey credentials (known to both script and tests)
KID="00112233445566778899aabbccddeeff"
KEY="0123456789abcdef0123456789abcdef"

# Reconstruct per-rendition fragmented MP4s by concatenating init + media segments
# from the plaintext DASH output. Parse segment filenames from the manifest.
MPD="$OUT_DIR/manifest.mpd"

# Discover stream count from init segment files
INIT_FILES=()
while IFS= read -r f; do
  INIT_FILES+=("$f")
done < <(ls "$OUT_DIR"/init-stream*.m4s 2>/dev/null | sort)

if [ ${#INIT_FILES[@]} -eq 0 ]; then
  echo "Error: no init-stream*.m4s files found in $OUT_DIR" >&2
  exit 1
fi

TEMP_DIR="$OUT_DIR/_enc_tmp"
mkdir -p "$TEMP_DIR"

PACKAGER_ARGS=()
STREAM_IDX=0

for init_file in "${INIT_FILES[@]}"; do
  # Extract stream number from filename like "init-stream0.m4s"
  base="$(basename "$init_file")"
  stream_num="${base#init-stream}"
  stream_num="${stream_num%.m4s}"

  # Concatenate init + chunks into a single fragmented MP4
  fmp4="$TEMP_DIR/rendition${stream_num}.mp4"
  cat "$init_file" "$OUT_DIR"/chunk-stream${stream_num}-*.m4s > "$fmp4"

  # Detect stream type (video or audio) via ffprobe
  codec_type="$(ffprobe -v error -select_streams 0 -show_entries stream=codec_type -of csv=p=0 "$fmp4" | head -1)"
  if [ "$codec_type" = "audio" ]; then
    stream_type="audio"
  else
    stream_type="video"
  fi

  PACKAGER_ARGS+=("in=${fmp4},stream=${stream_type},output=${ENCRYPTED_DIR}/stream${stream_num}.mp4")
  STREAM_IDX=$((STREAM_IDX + 1))
done

packager \
  "${PACKAGER_ARGS[@]}" \
  --enable_raw_key_encryption \
  --keys "key_id=${KID}:key=${KEY}" \
  --protection_scheme cenc \
  --clear_lead 0 \
  --mpd_output "${ENCRYPTED_DIR}/manifest.mpd" \
  --segment_duration 2

# Cleanup temp directory
rm -rf "$TEMP_DIR"

echo "==> Encrypted DASH fixture ready in $ENCRYPTED_DIR"
ls -lh "$ENCRYPTED_DIR"

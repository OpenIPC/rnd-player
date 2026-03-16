#!/usr/bin/env bash
set -euo pipefail

# Upload fixture directories as individual zips to a GitHub Release tagged "e2e-fixtures".
# Requires: GH_TOKEN with contents:write, gh CLI, fixture directory as $1.

FIXTURE_DIR="${1:?Usage: $0 <fixture-dir>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAG="e2e-fixtures"

HASH=$("$SCRIPT_DIR/fixture-hash.sh")
echo "Fixture hash: $HASH"

# Ensure the release exists
if ! gh release view "$TAG" &>/dev/null; then
  echo "Creating release $TAG..."
  gh release create "$TAG" --title "E2E Fixtures" --notes "Auto-generated DASH fixtures for E2E tests. Do not delete." --latest=false
fi

# Zip and upload each fixture subdirectory + root h264 fixture
TEMP_ZIP="$(mktemp -d)"
trap 'rm -rf "$TEMP_ZIP"' EXIT

# Root directory contains the H.264 manifest + segments
echo "Zipping h264 fixture..."
(cd "$FIXTURE_DIR" && zip -q -r "$TEMP_ZIP/h264.zip" manifest.mpd init-stream*.m4s chunk-stream*.m4s 2>/dev/null || true)

# Sub-fixtures: aq, encrypted, hevc, hevc-aq, av1
for sub in aq encrypted hevc hevc-aq av1; do
  if [ -d "$FIXTURE_DIR/$sub" ]; then
    echo "Zipping $sub fixture..."
    (cd "$FIXTURE_DIR" && zip -q -r "$TEMP_ZIP/$sub.zip" "$sub/")
  fi
done

# Write hash file
echo "$HASH" > "$TEMP_ZIP/fixture-hash.txt"

# Upload all zips + hash (clobber existing)
echo "Uploading to release $TAG..."
gh release upload "$TAG" --clobber "$TEMP_ZIP"/*.zip "$TEMP_ZIP/fixture-hash.txt"

echo "Upload complete."

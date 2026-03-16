#!/usr/bin/env bash
set -euo pipefail

# Download cached fixtures from a GitHub Release.
# Exits 0 on cache hit (fixtures extracted), 1 on cache miss.
# Usage: bash e2e/download-fixtures.sh <output-dir>

FIXTURE_DIR="${1:?Usage: $0 <output-dir>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAG="e2e-fixtures"

LOCAL_HASH=$("$SCRIPT_DIR/fixture-hash.sh")
echo "Local fixture hash: $LOCAL_HASH"

# Check if release exists
if ! gh release view "$TAG" &>/dev/null; then
  echo "No fixture release found."
  exit 1
fi

# Download and compare hash
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

if ! gh release download "$TAG" --pattern "fixture-hash.txt" --dir "$TEMP_DIR" 2>/dev/null; then
  echo "No fixture-hash.txt in release."
  exit 1
fi

REMOTE_HASH=$(cat "$TEMP_DIR/fixture-hash.txt")
echo "Remote fixture hash: $REMOTE_HASH"

if [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
  echo "Hash mismatch — cache invalidated."
  exit 1
fi

echo "Cache hit! Downloading fixtures..."
mkdir -p "$FIXTURE_DIR"

# Download all available zips
gh release download "$TAG" --pattern "*.zip" --dir "$TEMP_DIR" 2>/dev/null || true

# Extract h264 (root-level files)
if [ -f "$TEMP_DIR/h264.zip" ]; then
  echo "Extracting h264..."
  unzip -qo "$TEMP_DIR/h264.zip" -d "$FIXTURE_DIR"
fi

# Extract sub-fixtures
for sub in aq encrypted hevc hevc-aq av1; do
  if [ -f "$TEMP_DIR/$sub.zip" ]; then
    echo "Extracting $sub..."
    unzip -qo "$TEMP_DIR/$sub.zip" -d "$FIXTURE_DIR"
  fi
done

echo "Fixtures ready in $FIXTURE_DIR"
ls -lhR "$FIXTURE_DIR" | head -40
exit 0

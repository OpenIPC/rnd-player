#!/usr/bin/env bash
set -euo pipefail

# Compute a deterministic cache key from the fixture generation script.
# When the hash changes, cached fixtures are invalidated and regenerated.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Use sha256sum (Linux) or shasum (macOS)
if command -v sha256sum &>/dev/null; then
  HASH=$(sha256sum "$SCRIPT_DIR/generate-dash-fixture.sh" | cut -c1-16)
else
  HASH=$(shasum -a 256 "$SCRIPT_DIR/generate-dash-fixture.sh" | cut -c1-16)
fi

echo "fixtures-${HASH}"

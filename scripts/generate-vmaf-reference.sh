#!/usr/bin/env bash
#
# Generate VMAF reference scores from native libvmaf for validation.
#
# Generates deterministic Y4M fixtures via the TS script, runs libvmaf
# on each pair with multiple models, and assembles results into
# src/test/fixtures/vmaf-reference-scores.json.
#
# Requirements: Node.js + tsx, and either `vmaf` CLI or `ffmpeg` with libvmaf.
#
# Usage:
#   bash scripts/generate-vmaf-reference.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="/tmp/vmaf-fixtures"
OUTPUT_JSON="$PROJECT_DIR/src/test/fixtures/vmaf-reference-scores.json"
RESULTS_DIR="/tmp/vmaf-results"

W=120
H=68

# Test cases (must match vmaf-generate-y4m.ts output)
ALL_CASES=(identity brightness blur_box posterize checkerboard contrast edges_blur motion)

# ============================================================================
# Step 1: Generate Y4M fixtures
# ============================================================================

echo "=== Step 1: Generating Y4M fixtures ==="
npx --yes tsx "$SCRIPT_DIR/vmaf-generate-y4m.ts" --output-dir "$FIXTURE_DIR"
echo ""

# ============================================================================
# Step 2: Detect available tool
# ============================================================================

TOOL=""
TOOL_VERSION=""

if command -v vmaf &>/dev/null; then
  TOOL="vmaf"
  TOOL_VERSION=$(vmaf --version 2>&1 || echo "unknown")
  echo "=== Using vmaf CLI (version: $TOOL_VERSION) ==="
elif command -v ffmpeg &>/dev/null && ffmpeg -filters 2>&1 | grep -q libvmaf; then
  TOOL="ffmpeg"
  TOOL_VERSION=$(ffmpeg -version 2>&1 | head -1)
  echo "=== Using ffmpeg with libvmaf ($TOOL_VERSION) ==="
else
  echo "ERROR: Neither 'vmaf' CLI nor 'ffmpeg' with libvmaf found."
  echo "Install libvmaf: https://github.com/Netflix/vmaf"
  exit 1
fi

echo ""

# ============================================================================
# Step 3: Run libvmaf on each test pair
# ============================================================================

rm -rf "$RESULTS_DIR"
mkdir -p "$RESULTS_DIR"

run_vmaf() {
  local case_name="$1"
  local model_version="$2"
  local suffix="$3"

  local ref_y4m="$FIXTURE_DIR/$case_name/ref.y4m"
  local dis_y4m="$FIXTURE_DIR/$case_name/dis.y4m"
  local out_json="$RESULTS_DIR/${case_name}_${suffix}.json"

  if [ "$TOOL" = "vmaf" ]; then
    vmaf -r "$ref_y4m" -d "$dis_y4m" \
      --model "version=$model_version" \
      --feature vif --feature adm --feature motion \
      --json -o "$out_json" 2>/dev/null
  else
    ffmpeg -i "$dis_y4m" -i "$ref_y4m" \
      -lavfi "[0:v][1:v]libvmaf=model=version=$model_version:feature=name=vif:feature=name=adm:feature=name=motion:log_path=$out_json:log_fmt=json" \
      -f null - 2>/dev/null
  fi

  echo "  $case_name ($suffix): done"
}

echo "=== Step 3: Running libvmaf ==="

for case_name in "${ALL_CASES[@]}"; do
  # HD model (vmaf_v0.6.1) — default integer extractors
  run_vmaf "$case_name" "vmaf_v0.6.1" "hd"
  # 4K model
  run_vmaf "$case_name" "vmaf_4k_v0.6.1" "4k"
done

echo ""

# ============================================================================
# Step 4: Assemble JSON
# ============================================================================

echo "=== Step 4: Assembling reference scores ==="

mkdir -p "$(dirname "$OUTPUT_JSON")"

CASES_STR=$(IFS=' '; echo "${ALL_CASES[*]}")

node -e "
const fs = require('fs');
const path = require('path');

const resultsDir = '$RESULTS_DIR';
const allCases = '$CASES_STR'.split(' ');
const tool = '$TOOL';
const toolVersion = '$TOOL_VERSION';

function extractScores(jsonPath) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const frames = data.frames || [];
  return frames.map(f => {
    const m = f.metrics || {};
    return {
      vmaf: m.vmaf ?? null,
      vif_scale0: m.integer_vif_scale0 ?? m.vif_scale0 ?? null,
      vif_scale1: m.integer_vif_scale1 ?? m.vif_scale1 ?? null,
      vif_scale2: m.integer_vif_scale2 ?? m.vif_scale2 ?? null,
      vif_scale3: m.integer_vif_scale3 ?? m.vif_scale3 ?? null,
      adm2: m.integer_adm2 ?? m.adm2 ?? null,
      motion2: m.integer_motion2 ?? m.motion2 ?? null,
      motion: m.integer_motion ?? m.motion ?? null,
    };
  });
}

const result = {
  generator: 'generate-vmaf-reference.sh',
  tool: tool,
  tool_version: toolVersion,
  resolution: { width: $W, height: $H },
  hd: {},
  fourk: {},
};

for (const caseName of allCases) {
  const hdPath = path.join(resultsDir, caseName + '_hd.json');
  const fourkPath = path.join(resultsDir, caseName + '_4k.json');

  if (fs.existsSync(hdPath)) {
    result.hd[caseName] = { frames: extractScores(hdPath) };
  }
  if (fs.existsSync(fourkPath)) {
    result.fourk[caseName] = { frames: extractScores(fourkPath) };
  }
}

fs.writeFileSync('$OUTPUT_JSON', JSON.stringify(result, null, 2) + '\n');
console.log('Written: $OUTPUT_JSON');
console.log('Cases:', allCases.length);
" 2>&1

echo ""
echo "=== Done ==="
echo "Reference scores saved to: $OUTPUT_JSON"
echo ""
echo "To validate, run:"
echo "  npx vitest run src/utils/vmafLibvmafValidation.test.ts"

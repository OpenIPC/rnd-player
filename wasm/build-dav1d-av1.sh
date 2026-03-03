#!/usr/bin/env bash
#
# Build a minimal WASM QP map decoder using the dav1d AV1 decoder.
#
# dav1d is the high-performance C AV1 decoder by VideoLAN. This script
# clones dav1d, patches src/decode.c to capture per-superblock q_index
# into a global buffer, and compiles to standalone WASM via Emscripten.
#
# Bypasses meson — compiles .c files directly with emcc.
#
# Prerequisites:
#   - Emscripten SDK (emsdk) installed and activated
#   - Git for cloning dav1d
#
# Output: ../public/dav1d-qp.wasm
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
DAV1D_DIR="${BUILD_DIR}/dav1d-repo"
OUTPUT_DIR="${SCRIPT_DIR}/../public"
DAV1D_TAG="1.5.1"

echo "=== dav1d AV1 Decoder — QP Map WASM Build ==="

# ── Check Emscripten ──
if ! command -v emcc &>/dev/null; then
  echo "Error: Emscripten (emcc) not found. Install emsdk first."
  echo "  https://emscripten.org/docs/getting_started/"
  exit 1
fi

echo "Using Emscripten: $(emcc --version | head -1)"

# ── Clone dav1d ──
mkdir -p "${BUILD_DIR}"
if [ ! -d "${DAV1D_DIR}" ]; then
  echo "Cloning dav1d ${DAV1D_TAG}..."
  git clone --depth 1 --branch "${DAV1D_TAG}" https://github.com/videolan/dav1d.git "${DAV1D_DIR}"
fi

if [ ! -d "${DAV1D_DIR}/src" ]; then
  echo "Error: dav1d source not found at ${DAV1D_DIR}/src"
  exit 1
fi

echo "dav1d source: ${DAV1D_DIR}"

# ── Generate config.h and vcs_version.h (normally done by meson) ──
CONFIG_H="${DAV1D_DIR}/src/config.h"
if [ ! -f "${CONFIG_H}" ]; then
  echo "Generating config.h..."
  cp "${SCRIPT_DIR}/dav1d_overrides.h" "${CONFIG_H}"
fi

VCS_VERSION_H="${DAV1D_DIR}/include/vcs_version.h"
if [ ! -f "${VCS_VERSION_H}" ]; then
  echo "Generating vcs_version.h..."
  cat > "${VCS_VERSION_H}" << EOF
#define DAV1D_VERSION "${DAV1D_TAG}"
EOF
fi

# ── Apply patches ──
echo ""
echo "Applying patches for WASM QP capture..."

DECODE_SRC="${DAV1D_DIR}/src/decode.c"

# Patch 1: QP capture hook in decode.c
# After delta_q is applied in decode_b(), store ts->last_qidx into global buffer
if ! grep -q "g_qp_sb_grid" "${DECODE_SRC}" 2>/dev/null; then
  echo "  Patch 1: decode.c — QP capture at superblock boundary"

  DECODE_SRC_PATH="${DECODE_SRC}" python3 << 'PYEOF'
import re, os

src_path = os.environ.get("DECODE_SRC_PATH")
with open(src_path, 'r') as f:
    src = f.read()

# Insert extern declarations after the includes block
# Find the last #include line before the first function
marker = '#include "src/warpmv.h"'
marker_pos = src.index(marker)
insert_pos = src.index('\n', marker_pos) + 1

extern_decls = """
/* WASM: QP capture globals — filled at each superblock boundary */
extern uint8_t g_qp_sb_grid[];
extern int g_qp_sb_stride;
extern int g_qp_sb_rows;
extern int g_qp_sb_size;
extern int g_qp_frame_w;
extern int g_qp_frame_h;
extern int g_qp_capture_active;
"""
src = src[:insert_pos] + extern_decls + src[insert_pos:]

# Patch: after the delta_q block updates ts->last_qidx and assigns
# dequant tables, store the q_index into the global grid.
# We look for the pattern where the dequant table is assigned after delta_q.
#
# The code block we're targeting:
#   if (ts->last_qidx == f->frame_hdr->quant.yac) {
#       // assign frame-wide q values to this sb
#       ts->dq = f->dq;
#   } else if (ts->last_qidx != prev_qidx) {
#       ...
#       ts->dq = ts->dqmem;
#   }
#
# We insert our capture code AFTER this entire if/else block.

# Find the marker: "if (!ts->last_delta_lf.u32)" which comes right after
# the dequant table assignment block
lf_marker = "if (!ts->last_delta_lf.u32) {"
lf_pos = src.index(lf_marker)

# Insert our QP capture code right before this line
capture_code = """        /* WASM: capture q_index for this superblock */
        if (g_qp_capture_active) {
            const int sb_shift = f->seq_hdr->sb128 ? 5 : 4;
            const int sbx = t->bx >> sb_shift;
            const int sby = t->by >> sb_shift;
            const int sb_size = f->seq_hdr->sb128 ? 128 : 64;
            const int sb_w = (f->cur.p.w + sb_size - 1) / sb_size;
            const int sb_h = (f->cur.p.h + sb_size - 1) / sb_size;

            g_qp_sb_stride = sb_w;
            g_qp_sb_rows = sb_h;
            g_qp_sb_size = sb_size;

            const int sb_idx = sby * sb_w + sbx;
            if (sb_idx >= 0 && sb_idx < 16384) {
                g_qp_sb_grid[sb_idx] = (uint8_t)(ts->last_qidx & 0xFF);
            }
        }
"""

src = src[:lf_pos] + capture_code + src[lf_pos:]

with open(src_path, 'w') as f:
    f.write(src)

print("    decode.c patched for QP capture")
PYEOF
fi

# Patch 2: cpu.c — stub dav1d_get_cpu_flags to return 0 (no SIMD)
CPU_SRC="${DAV1D_DIR}/src/cpu.c"
if ! grep -q "WASM: no SIMD" "${CPU_SRC}" 2>/dev/null; then
  echo "  Patch 2: cpu.c — disable SIMD detection"
  CPU_SRC_PATH="${CPU_SRC}" python3 << 'PYEOF'
import os

src_path = os.environ.get("CPU_SRC_PATH")
with open(src_path, 'r') as f:
    src = f.read()

# Replace the dav1d_get_cpu_flags_soft function to always return 0
# This prevents any ASM init functions from being called
old = "COLD unsigned dav1d_get_cpu_flags(void) {"
if old in src:
    new = old + "\n    return 0; /* WASM: no SIMD */"
    src = src.replace(old, new, 1)

with open(src_path, 'w') as f:
    f.write(src)

print("    cpu.c patched")
PYEOF
fi

# ── Collect source files ──
echo ""
echo "Collecting source files..."

# Regular (non-templated) sources
REGULAR_SOURCES=""
REGULAR_LIST=(
  cdf.c cpu.c ctx.c data.c decode.c dequant_tables.c getbits.c
  intra_edge.c itx_1d.c lf_mask.c lib.c log.c mem.c msac.c
  obu.c pal.c picture.c qm.c ref.c refmvs.c scan.c tables.c
  thread_task.c warpmv.c wedge.c
)

for f in "${REGULAR_LIST[@]}"; do
  if [ -f "${DAV1D_DIR}/src/${f}" ]; then
    REGULAR_SOURCES="${REGULAR_SOURCES} ${DAV1D_DIR}/src/${f}"
  else
    echo "  WARNING: missing ${f}"
  fi
done

# Templated sources — compiled twice (BITDEPTH=8 and BITDEPTH=16)
TMPL_LIST=(
  cdef_apply_tmpl.c cdef_tmpl.c fg_apply_tmpl.c filmgrain_tmpl.c
  ipred_prepare_tmpl.c ipred_tmpl.c itx_tmpl.c lf_apply_tmpl.c
  loopfilter_tmpl.c looprestoration_tmpl.c lr_apply_tmpl.c
  mc_tmpl.c recon_tmpl.c
)

WRAPPER_SRC="${SCRIPT_DIR}/dav1d_wrapper.c"

REGULAR_COUNT=$(echo ${REGULAR_SOURCES} | wc -w | tr -d ' ')
TMPL_COUNT=${#TMPL_LIST[@]}
echo "  Regular sources: ${REGULAR_COUNT} files"
echo "  Template sources: ${TMPL_COUNT} files (x2 bitdepths)"
echo "  Wrapper: 1 file"

# ── Compile templated sources to object files ──
echo ""
echo "Compiling templated sources..."

OBJ_DIR="${BUILD_DIR}/dav1d-obj"
mkdir -p "${OBJ_DIR}"

COMMON_FLAGS=(
  -O2
  -DNDEBUG
  -include "${SCRIPT_DIR}/dav1d_overrides.h"
  -I "${DAV1D_DIR}"
  -I "${DAV1D_DIR}/include"
  -I "${DAV1D_DIR}/src"
  -Wno-unused-variable
  -Wno-unused-function
  -Wno-unused-but-set-variable
)

TMPL_OBJS=""
for f in "${TMPL_LIST[@]}"; do
  base="${f%.c}"
  src_path="${DAV1D_DIR}/src/${f}"
  if [ ! -f "${src_path}" ]; then
    echo "  WARNING: missing template ${f}"
    continue
  fi

  # 8-bit
  obj8="${OBJ_DIR}/${base}_8.o"
  if [ ! -f "${obj8}" ] || [ "${src_path}" -nt "${obj8}" ]; then
    emcc "${COMMON_FLAGS[@]}" -DBITDEPTH=8 -c "${src_path}" -o "${obj8}"
  fi
  TMPL_OBJS="${TMPL_OBJS} ${obj8}"

  # 16-bit
  obj16="${OBJ_DIR}/${base}_16.o"
  if [ ! -f "${obj16}" ] || [ "${src_path}" -nt "${obj16}" ]; then
    emcc "${COMMON_FLAGS[@]}" -DBITDEPTH=16 -c "${src_path}" -o "${obj16}"
  fi
  TMPL_OBJS="${TMPL_OBJS} ${obj16}"
done

echo "  Compiled ${TMPL_COUNT} x 2 = $((TMPL_COUNT * 2)) template objects"

# ── Compile and link everything ──
echo ""
echo "Compiling to WASM..."
mkdir -p "${OUTPUT_DIR}"

emcc -O2 \
  -DNDEBUG \
  -s STANDALONE_WASM=1 \
  -s TOTAL_MEMORY=67108864 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MALLOC=emmalloc \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -Wno-unused-variable \
  -Wno-unused-function \
  -Wno-unused-but-set-variable \
  -Wl,--allow-multiple-definition \
  -include "${SCRIPT_DIR}/dav1d_overrides.h" \
  -I "${DAV1D_DIR}" \
  -I "${DAV1D_DIR}/include" \
  -I "${DAV1D_DIR}/src" \
  "${WRAPPER_SRC}" \
  ${REGULAR_SOURCES} \
  ${TMPL_OBJS} \
  -o "${OUTPUT_DIR}/dav1d-qp.wasm"

WASM_SIZE=$(du -h "${OUTPUT_DIR}/dav1d-qp.wasm" | cut -f1)
echo ""
echo "=== Build complete ==="
echo "Output: ${OUTPUT_DIR}/dav1d-qp.wasm (${WASM_SIZE})"
echo ""
echo "The WASM binary will be served from the public/ directory."
echo "In development: npm run dev"
echo "In production: the WASM file is copied to dist/ during build."

#!/usr/bin/env bash
#
# Build a minimal WASM QP map decoder using the JM H.264 reference decoder.
#
# The JM (Joint Model) is the ITU-T/ISO reference implementation for H.264/AVC.
# This script clones JM 19.0, patches it for in-memory operation (no file I/O),
# and compiles to standalone WASM via Emscripten.
#
# Prerequisites:
#   - Emscripten SDK (emsdk) installed and activated
#   - Git for cloning JM
#
# Output: ../public/jm264-qp.wasm
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
JM_DIR="${BUILD_DIR}/JM"
OUTPUT_DIR="${SCRIPT_DIR}/../public"

echo "=== JM H.264 Reference Decoder — QP Map WASM Build ==="

# ── Check Emscripten ──
if ! command -v emcc &>/dev/null; then
  echo "Error: Emscripten (emcc) not found. Install emsdk first."
  echo "  https://emscripten.org/docs/getting_started/"
  exit 1
fi

echo "Using Emscripten: $(emcc --version | head -1)"

# ── Clone JM ──
mkdir -p "${BUILD_DIR}"
if [ ! -d "${JM_DIR}" ]; then
  echo "Cloning JM H.264 reference decoder..."
  # Primary: Fraunhofer HHI GitLab. Fallback: GitHub mirror.
  git clone --depth 1 https://vcgit.hhi.fraunhofer.de/jvet/JM.git "${JM_DIR}" 2>/dev/null \
    || git clone --depth 1 https://github.com/shihuade/JM.git "${JM_DIR}"
fi

echo "JM source: ${JM_DIR}"

# ── Apply patches ──
echo ""
echo "Applying patches for WASM memory-buffer operation..."

# Patch 1+2: annexb.c — Replace file read with memory buffer
ANNEXB_SRC="${JM_DIR}/ldecod/src/annexb.c"

if ! grep -q "g_mem_buf" "${ANNEXB_SRC}" 2>/dev/null; then
  echo "  Patch 1: annexb.c — memory buffer for getChunk() + skip file open"

  ANNEXB_SRC_PATH="${ANNEXB_SRC}" python3 << 'PYEOF'
import re, os

src_path = os.environ.get("ANNEXB_SRC_PATH")
with open(src_path, 'r') as f:
    src = f.read()

# Add extern declarations after the last #include
last_include = src.rfind('#include')
insert_pos = src.index('\n', last_include) + 1
extern_decls = """
/* WASM memory buffer — set by jm264_wrapper.c before decode */
extern const unsigned char *g_mem_buf;
extern int g_mem_pos;
extern int g_mem_len;
"""
src = src[:insert_pos] + extern_decls + src[insert_pos:]

# Patch getChunk — match "static inline int getChunk" or "static int getChunk"
old_pattern = r'(static\s+(?:inline\s+)?int\s+getChunk\s*\([^)]*\)\s*\{)'
replacement = r"""\1
  /* WASM: read from memory buffer instead of file */
  if (g_mem_buf != NULL) {
    int avail = g_mem_len - g_mem_pos;
    if (avail <= 0) { annex_b->is_eof = TRUE; return 0; }
    int to_read = (avail < annex_b->iIOBufferSize) ? avail : annex_b->iIOBufferSize;
    memcpy(annex_b->iobuffer, g_mem_buf + g_mem_pos, to_read);
    g_mem_pos += to_read;
    annex_b->bytesinbuffer = to_read;
    annex_b->iobufferread = annex_b->iobuffer;
    return to_read;
  }
"""
src, n = re.subn(old_pattern, replacement, src, count=1)
assert n == 1, f"getChunk patch failed to match (n={n})"

# Patch open_annex_b — add early return when using memory buffer
old_pattern = r'(void\s+open_annex_b\s*\([^)]*\)\s*\{)'
replacement = r"""\1
  /* WASM: skip file open — we read from memory buffer */
  if (g_mem_buf != NULL) {
    annex_b->BitStreamFile = -1;
    annex_b->bytesinbuffer = 0;
    if (annex_b->iobuffer == NULL) {
      annex_b->iIOBufferSize = 65536;
      annex_b->iobuffer = (byte *)malloc(annex_b->iIOBufferSize);
    }
    annex_b->iobufferread = annex_b->iobuffer;
    annex_b->is_eof = FALSE;
    annex_b->IsFirstByteStreamNALU = 1;
    annex_b->nextstartcodebytes = 0;
    getChunk(annex_b);
    return;
  }
"""
src, n = re.subn(old_pattern, replacement, src, count=1)
assert n == 1, f"open_annex_b patch failed to match (n={n})"

with open(src_path, 'w') as f:
    f.write(src)

print("    annexb.c patched successfully")
PYEOF
fi

# Patch 3: output.c — Capture QP via callback + suppress YUV file writes
OUTPUT_SRC="${JM_DIR}/ldecod/src/output.c"
if ! grep -q "jm264_on_frame_output" "${OUTPUT_SRC}" 2>/dev/null; then
  echo "  Patch 3: output.c — QP capture callback + suppress YUV file writes"

  python3 -c "
import re
with open('${OUTPUT_SRC}', 'r') as f:
    src = f.read()

# Replace write_out_picture with QP capture callback + early return.
# If previously patched with just 'WASM: suppress', this replaces that too.
old_pattern = r'(static\s+void\s+write_out_picture\s*\([^)]*\)\s*\{)'
replacement = r'''\1
  /* WASM: capture QP data before frame leaves the decoder pipeline,
   * then suppress YUV output. This fires BEFORE DPB management which
   * might trigger error(), ensuring we have QP data even on errors. */
  extern void jm264_on_frame_output(void);
  jm264_on_frame_output();
  (void)p_Vid; (void)p; (void)p_out;
  return;
'''
src = re.sub(old_pattern, replacement, src, count=1)

with open('${OUTPUT_SRC}', 'w') as f:
    f.write(src)
"
fi

# Patch 4: configfile.c — Skip CLI/config parsing
CONFIG_SRC="${JM_DIR}/ldecod/src/configfile.c"
if ! grep -q "WASM: skip" "${CONFIG_SRC}" 2>/dev/null; then
  echo "  Patch 4: configfile.c — skip CLI/config parsing"

  python3 -c "
import re
with open('${CONFIG_SRC}', 'r') as f:
    src = f.read()

# Stub ParseCommand — signature: ParseCommand(InputParameters *p_Inp, int ac, char *av[])
old_pattern = r'(void ParseCommand\s*\([^)]*\)\s*\{)'
replacement = r'''\1
  /* WASM: skip CLI parsing — defaults are set by wrapper */
  (void)p_Inp;
  (void)ac;
  (void)av;
  return;
'''
src = re.sub(old_pattern, replacement, src, count=1)

with open('${CONFIG_SRC}', 'w') as f:
    f.write(src)
"
fi

# Patch 5: report.c — Suppress report file writes (if it exists)
REPORT_SRC="${JM_DIR}/ldecod/src/report.c"
if [ -f "${REPORT_SRC}" ] && ! grep -q "WASM: suppress" "${REPORT_SRC}" 2>/dev/null; then
  echo "  Patch 5: report.c — suppress report writes"

  python3 -c "
import re
with open('${REPORT_SRC}', 'r') as f:
    src = f.read()

# Stub report function(s)
for func in ['void report_stats_on_error', 'void report']:
    old_pattern = r'(' + re.escape(func) + r'\s*\([^)]*\)\s*\{)'
    replacement = r'''\1
  /* WASM: suppress report output */
  return;
'''
    src = re.sub(old_pattern, replacement, src, count=1)

with open('${REPORT_SRC}', 'w') as f:
    f.write(src)
"
else
  echo "  Patch 5: report.c — skipped (file not present in this JM version)"
fi

# Patch 6: ldecod.c — Suppress Report() log file writes
LDECOD_SRC="${JM_DIR}/ldecod/src/ldecod.c"
if [ -f "${LDECOD_SRC}" ] && ! grep -q "WASM: suppress" "${LDECOD_SRC}" 2>/dev/null; then
  echo "  Patch 6: ldecod.c — suppress Report() log file writes"

  python3 -c "
import re
with open('${LDECOD_SRC}', 'r', encoding='latin-1') as f:
    src = f.read()

# Stub Report to skip file writes
old_pattern = r'(static void Report\s*\(VideoParameters \*p_Vid\)\s*\{)'
replacement = r'''\1
  /* WASM: suppress report log file writes */
  (void)p_Vid;
  return;
'''
src = re.sub(old_pattern, replacement, src, count=1)

with open('${LDECOD_SRC}', 'w', encoding='latin-1') as f:
    f.write(src)
"
fi

# Patch 7: defines.h — Disable TRACE and fix duplicate symbol 'ColorComponent'
DEFINES_INC="${JM_DIR}/ldecod/inc/defines.h"
if grep -q "# define TRACE           1" "${DEFINES_INC}" 2>/dev/null; then
  echo "  Patch 7: defines.h — disable TRACE, fix duplicate symbol"
  # Disable TRACE (JM defaults TRACE=1 which requires fopen for trace file)
  sed -i.bak 's/# define TRACE           1/# define TRACE           0/g' "${DEFINES_INC}"
  # Fix duplicate symbol: enum variable → anonymous enum
  sed -i.bak2 's/^} ColorComponent;/};/' "${DEFINES_INC}"
fi

# Patch 8: mbuffer.c — Make DPB size checks non-fatal with value clamping.
# Real-world encoders (x264, etc.) often violate DPB size limits.
# JM calls error() which exits. We replace with printf + clamp the values
# so the decoder doesn't continue with a too-small DPB (which causes crashes).
MBUFFER_SRC="${JM_DIR}/ldecod/src/mbuffer.c"
if grep -q 'error ("max_dec_frame_buffering larger than MaxDpbSize"' "${MBUFFER_SRC}" 2>/dev/null; then
  echo "  Patch 8: mbuffer.c — make DPB size checks non-fatal + clamp values"

  MBUFFER_SRC_PATH="${MBUFFER_SRC}" python3 << 'PYEOF'
import re, os

mbuffer_src = os.environ.get("MBUFFER_SRC_PATH")
with open(mbuffer_src, "r") as f:
    src = f.read()

# 8a: Replace all "max_dec_frame_buffering larger than MaxDpbSize" error calls
src = src.replace(
    'error ("max_dec_frame_buffering larger than MaxDpbSize", 500);',
    'printf("Warning: max_dec_frame_buffering > MaxDpbSize (clamped)\\n");'
)

# 8b: In init_dpb, after the DPB-size-vs-num_ref_frames check, clamp p_Dpb->size
old = '''  if (p_Dpb->size < active_sps->num_ref_frames)
#endif
  {
    error ("DPB size at specified level is smaller than the specified number of reference frames. This is not allowed.\\n", 1000);
  }'''
new = '''  if (p_Dpb->size < active_sps->num_ref_frames)
#endif
  {
    printf("Warning: DPB size (%d) < num_ref_frames (%d), clamping\\n", p_Dpb->size, active_sps->num_ref_frames);
    p_Dpb->size = active_sps->num_ref_frames;
  }'''
src = src.replace(old, new)

# 8c: In getMaxDecBufferingMVC, same error but different context — just warn
src = src.replace(
    'error ("DPB size at specified level is smaller than the specified number of reference frames. This is not allowed.\\n", 1000);',
    'printf("Warning: DPB size < num_ref_frames (clamped)\\n");'
)

with open(mbuffer_src, "w") as f:
    f.write(src)

print("    mbuffer.c patched: DPB errors non-fatal + values clamped")
PYEOF
fi

# Patch 9: image.c — Make "unintentional loss of pictures" non-fatal.
# Safety net: with conceal_mode=1 this branch is normally unreachable,
# but if some code path resets conceal_mode to 0, this prevents exit().
IMAGE_SRC="${JM_DIR}/ldecod/src/image.c"
if grep -q 'error("An unintentional loss of pictures occurs' "${IMAGE_SRC}" 2>/dev/null; then
  echo "  Patch 9: image.c — make 'unintentional loss of pictures' non-fatal"

  IMAGE_SRC_PATH="${IMAGE_SRC}" python3 << 'PYEOF'
import os
image_src = os.environ.get("IMAGE_SRC_PATH")
with open(image_src, "r") as f:
    src = f.read()

src = src.replace(
    'error("An unintentional loss of pictures occurs! Exit\\n", 100);',
    'printf("Warning: unintentional loss of pictures (continuing with concealment)\\n");'
)

with open(image_src, "w") as f:
    f.write(src)

print("    image.c patched: picture loss error now non-fatal")
PYEOF
fi

# ── Collect source files ──
echo ""
echo "Collecting source files..."

# ldecod/src/*.c — exclude files with main() or unwanted I/O
LDECOD_EXCLUDE="decoder_test.c rtp.c leaky_bucket.c"
LDECOD_SOURCES=""
for f in "${JM_DIR}"/ldecod/src/*.c; do
  base=$(basename "$f")
  skip=0
  for ex in ${LDECOD_EXCLUDE}; do
    if [ "$base" = "$ex" ]; then skip=1; break; fi
  done
  if [ $skip -eq 0 ]; then
    LDECOD_SOURCES="${LDECOD_SOURCES} $f"
  fi
done

# lcommon/src/*.c — exclude platform-specific files
LCOMMON_EXCLUDE="io_tiff.c win32.c"
LCOMMON_SOURCES=""
for f in "${JM_DIR}"/lcommon/src/*.c; do
  base=$(basename "$f")
  skip=0
  for ex in ${LCOMMON_EXCLUDE}; do
    if [ "$base" = "$ex" ]; then skip=1; break; fi
  done
  if [ $skip -eq 0 ]; then
    LCOMMON_SOURCES="${LCOMMON_SOURCES} $f"
  fi
done

WRAPPER_SRC="${SCRIPT_DIR}/jm264_wrapper.c"

LDECOD_COUNT=$(echo ${LDECOD_SOURCES} | wc -w | tr -d ' ')
LCOMMON_COUNT=$(echo ${LCOMMON_SOURCES} | wc -w | tr -d ' ')
echo "  ldecod: ${LDECOD_COUNT} files"
echo "  lcommon: ${LCOMMON_COUNT} files"
echo "  wrapper: 1 file"

# ── Compile ──
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
  -std=gnu99 \
  -fno-strict-aliasing \
  -fsigned-char \
  -Wno-implicit-function-declaration \
  -Wno-int-conversion \
  -Wno-incompatible-pointer-types \
  -Wl,--allow-multiple-definition \
  -include "${SCRIPT_DIR}/jm264_overrides.h" \
  -I "${JM_DIR}/ldecod/inc" \
  -I "${JM_DIR}/lcommon/inc" \
  "${WRAPPER_SRC}" \
  ${LDECOD_SOURCES} \
  ${LCOMMON_SOURCES} \
  -o "${OUTPUT_DIR}/jm264-qp.wasm"

WASM_SIZE=$(du -h "${OUTPUT_DIR}/jm264-qp.wasm" | cut -f1)
echo ""
echo "=== Build complete ==="
echo "Output: ${OUTPUT_DIR}/jm264-qp.wasm (${WASM_SIZE})"
echo ""
echo "The WASM binary will be served from the public/ directory."
echo "In development: npm run dev"
echo "In production: the WASM file is copied to dist/ during build."

#!/usr/bin/env bash
#
# Build a minimal WASM QP map decoder using the HM H.265/HEVC reference decoder.
#
# The HM (HEVC Test Model) is the ITU-T/ISO reference implementation for H.265/HEVC.
# This script uses HM 16.18 source from a GitHub mirror, patches it for in-memory
# operation (no file I/O), and compiles to standalone WASM via Emscripten.
#
# Prerequisites:
#   - Emscripten SDK (emsdk) installed and activated
#   - Git for cloning HM
#
# Output: ../public/hm265-qp.wasm
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
HM_REPO_DIR="${BUILD_DIR}/HM-repo"
HM_DIR="${HM_REPO_DIR}/src/HM-16.18"
OUTPUT_DIR="${SCRIPT_DIR}/../public"

echo "=== HM H.265 Reference Decoder — QP Map WASM Build ==="

# ── Check Emscripten ──
if ! command -v em++ &>/dev/null; then
  echo "Error: Emscripten (em++) not found. Install emsdk first."
  echo "  https://emscripten.org/docs/getting_started/"
  exit 1
fi

echo "Using Emscripten: $(em++ --version | head -1)"

# ── Clone HM ──
mkdir -p "${BUILD_DIR}"
if [ ! -d "${HM_DIR}" ]; then
  echo "Cloning HM H.265 reference decoder (HM 16.18)..."
  # GitHub mirror containing HM 16.18 source.
  # The official Fraunhofer HHI GitLab (vcgit.hhi.fraunhofer.de) is unreachable.
  rm -rf "${HM_REPO_DIR}"
  git clone --depth 1 https://github.com/chenying-wang/Fast-HEVC-Intra-Encoder.git "${HM_REPO_DIR}"
fi

if [ ! -d "${HM_DIR}/source" ]; then
  echo "Error: HM source not found at ${HM_DIR}/source"
  exit 1
fi

echo "HM source: ${HM_DIR}"

# ── Apply patches ──
echo ""
echo "Applying patches for WASM memory-buffer operation..."

# Patch 1: TAppDecTop.cpp — Replace file read with memory buffer
TAPPDECTOP_SRC="${HM_DIR}/source/App/TAppDecoder/TAppDecTop.cpp"

if ! grep -q "g_mem_buf" "${TAPPDECTOP_SRC}" 2>/dev/null; then
  echo "  Patch 1: TAppDecTop.cpp — memory buffer for bytestream input"

  TAPPDECTOP_SRC_PATH="${TAPPDECTOP_SRC}" python3 << 'PYEOF'
import re, os

src_path = os.environ.get("TAPPDECTOP_SRC_PATH")
with open(src_path, 'r') as f:
    src = f.read()

# Insert after #include "TAppDecTop.h" (which is outside any #if block)
# Not rfind — we need the specific include, not the last one (which may be inside #if)
marker = '#include "TAppDecTop.h"'
marker_pos = src.index(marker)
insert_pos = src.index('\n', marker_pos) + 1
extern_decls = """
/* WASM memory buffer -- set by hm265_wrapper.cpp before decode */
extern "C" {
  extern const unsigned char *g_mem_buf;
  extern int g_mem_pos;
  extern int g_mem_len;
}

/* Custom streambuf that reads from a memory buffer */
class MemBufStream : public std::streambuf {
public:
  MemBufStream(const char* base, size_t size) {
    char* p = const_cast<char*>(base);
    this->setg(p, p, p + size);
  }
};
"""
src = src[:insert_pos] + extern_decls + src[insert_pos:]

# Patch decode() — add early return path for memory buffer input
# Insert right after the opening brace of decode()
old_pattern = r'(Void TAppDecTop::decode\s*\(\s*\)\s*\{)'
replacement = r"""\1
  /* WASM: decode from memory buffer instead of file */
  if (g_mem_buf != NULL) {
    MemBufStream sbuf(reinterpret_cast<const char*>(g_mem_buf), g_mem_len);
    std::istream memStream(&sbuf);

    xCreateDecLib();
    xInitDecLib();

    Int                 poc;
    TComList<TComPic*>* pcListPic = NULL;

    InputByteStream bytestream(memStream);
    Bool loopFiltered = false;

    while (!!memStream) {
      streampos location = memStream.tellg();
      AnnexBStats stats = AnnexBStats();
      InputNALUnit nalu;
      byteStreamNALUnit(bytestream, nalu.getBitstream().getFifo(), stats);

      if (nalu.getBitstream().getFifo().empty()) {
        break;
      }

      read(nalu);
      Bool bNewPicture = m_cTDecTop.decode(nalu, m_iSkipFrame, m_iPOCLastDisplay);

      if (bNewPicture) {
        memStream.clear();
        memStream.seekg(location - streamoff(3));
        bytestream.reset();
      }

      if ((bNewPicture || !memStream || nalu.m_nalUnitType == NAL_UNIT_EOS) &&
          !m_cTDecTop.getFirstSliceInSequence()) {
        if (!loopFiltered || memStream) {
          m_cTDecTop.executeLoopFilters(poc, pcListPic);
        }
        loopFiltered = (nalu.m_nalUnitType == NAL_UNIT_EOS);
        if (nalu.m_nalUnitType == NAL_UNIT_EOS) {
          m_cTDecTop.setFirstSliceInSequence(true);
        }
      } else if ((bNewPicture || !memStream || nalu.m_nalUnitType == NAL_UNIT_EOS) &&
                 m_cTDecTop.getFirstSliceInSequence()) {
        m_cTDecTop.setFirstSliceInPicture(true);
      }

      if (pcListPic) {
        if (bNewPicture) {
          xWriteOutput(pcListPic, nalu.m_temporalId);
        }
        if ((bNewPicture || nalu.m_nalUnitType == NAL_UNIT_CODED_SLICE_CRA) &&
            m_cTDecTop.getNoOutputPriorPicsFlag()) {
          m_cTDecTop.checkNoOutputPriorPics(pcListPic);
          m_cTDecTop.setNoOutputPriorPicsFlag(false);
        }
        if (bNewPicture &&
            (nalu.m_nalUnitType == NAL_UNIT_CODED_SLICE_IDR_W_RADL ||
             nalu.m_nalUnitType == NAL_UNIT_CODED_SLICE_IDR_N_LP ||
             nalu.m_nalUnitType == NAL_UNIT_CODED_SLICE_BLA_N_LP ||
             nalu.m_nalUnitType == NAL_UNIT_CODED_SLICE_BLA_W_RADL ||
             nalu.m_nalUnitType == NAL_UNIT_CODED_SLICE_BLA_W_LP)) {
          xFlushOutput(pcListPic);
        }
        if (nalu.m_nalUnitType == NAL_UNIT_EOS) {
          xWriteOutput(pcListPic, nalu.m_temporalId);
          m_cTDecTop.setFirstSliceInPicture(false);
        }
        if (!bNewPicture && nalu.m_nalUnitType >= NAL_UNIT_CODED_SLICE_TRAIL_N &&
            nalu.m_nalUnitType <= NAL_UNIT_RESERVED_VCL31) {
          xWriteOutput(pcListPic, nalu.m_temporalId);
        }
      }
    }

    xFlushOutput(pcListPic);
    m_cTDecTop.deletePicBuffer();
    xDestroyDecLib();
    return;
  }
"""
src, n = re.subn(old_pattern, replacement, src, count=1)
assert n == 1, f"decode() patch failed to match (n={n})"

with open(src_path, 'w') as f:
    f.write(src)

print("    TAppDecTop.cpp patched for memory buffer decode")
PYEOF
fi

# Patch 2: TAppDecTop.cpp — QP capture in xWriteOutput (pass pcListPic to callback)
if ! grep -q "hm265_on_frame_output" "${TAPPDECTOP_SRC}" 2>/dev/null; then
  echo "  Patch 2: TAppDecTop.cpp — QP capture in xWriteOutput + xFlushOutput"

  TAPPDECTOP_SRC_PATH="${TAPPDECTOP_SRC}" python3 << 'PYEOF'
import re, os

src_path = os.environ.get("TAPPDECTOP_SRC_PATH")
with open(src_path, 'r') as f:
    src = f.read()

# First add top-level declarations for the callbacks and global pointer
marker = '#include "TAppDecTop.h"'
marker_pos = src.index(marker)
insert_after = src.index('\n', marker_pos) + 1
top_level_decls = """
/* WASM: QP capture callback declarations */
extern TComList<TComPic*> *g_current_pic_list;
extern "C" void hm265_on_frame_output(void);
extern "C" void hm265_on_flush_output(void);
extern "C" void hm265_on_pic_output(TComPic *pic);
"""
src = src[:insert_after] + top_level_decls + src[insert_after:]

# Patch xWriteOutput — add QP capture callback with pcListPic
old_pattern = r'(Void TAppDecTop::xWriteOutput\s*\([^)]*\)\s*\{)'
replacement = r"""\1
  /* WASM: capture QP data via callback, passing the picture list */
  g_current_pic_list = pcListPic;
  hm265_on_frame_output();
"""
src, n = re.subn(old_pattern, replacement, src, count=1)
assert n == 1, f"xWriteOutput patch failed to match (n={n})"

# Patch xFlushOutput — same callback for flushed frames
old_pattern = r'(Void TAppDecTop::xFlushOutput\s*\([^)]*\)\s*\{)'
replacement = r"""\1
  /* WASM: capture QP data from flushed frames */
  g_current_pic_list = pcListPic;
  hm265_on_flush_output();
"""
src, n = re.subn(old_pattern, replacement, src, count=1)
assert n == 1, f"xFlushOutput patch failed to match (n={n})"

with open(src_path, 'w') as f:
    f.write(src)

print("    xWriteOutput/xFlushOutput patched for QP capture")
PYEOF
fi

# Patch 2b: TAppDecTop.cpp — Per-picture callback in output loops
if ! grep -q "hm265_on_pic_output" "${TAPPDECTOP_SRC}" 2>/dev/null; then
  echo "  Patch 2b: TAppDecTop.cpp — per-picture QP capture in output loops"

  TAPPDECTOP_SRC_PATH="${TAPPDECTOP_SRC}" python3 << 'PYEOF'
import re, os

src_path = os.environ.get("TAPPDECTOP_SRC_PATH")
with open(src_path, 'r') as f:
    src = f.read()

# Insert per-picture callback in xWriteOutput frame loop (before setOutputMark(false))
# Pattern: in xWriteOutput, "pcPic->setOutputMark(false);\n      }\n\n      iterPic++;\n    }\n  }\n}"
# We add hm265_on_pic_output(pcPic) before setOutputMark in the frame decoding branch
old = '        pcPic->setOutputMark(false);\n      }\n\n      iterPic++;\n    }\n  }\n}'
new = '        /* WASM: capture QP/mode per-picture */\n        hm265_on_pic_output(pcPic);\n\n        pcPic->setOutputMark(false);\n      }\n\n      iterPic++;\n    }\n  }\n}'
assert old in src, "xWriteOutput per-pic patch: pattern not found"
src = src.replace(old, new, 1)

# Insert per-picture callback in xFlushOutput frame loop (before destroy)
# Pattern: "pcPic->setOutputMark(false);\n      }\n      if(pcPic != NULL)\n      {\n        pcPic->destroy();"
old2 = '        pcPic->setOutputMark(false);\n      }\n      if(pcPic != NULL)\n      {\n        pcPic->destroy();'
new2 = '        pcPic->setOutputMark(false);\n      }\n      /* WASM: capture QP/mode per-picture before destroy */\n      if (pcPic && pcPic->getReconMark()) {\n        hm265_on_pic_output(pcPic);\n      }\n      if(pcPic != NULL)\n      {\n        pcPic->destroy();'
assert old2 in src, "xFlushOutput per-pic patch: pattern not found"
src = src.replace(old2, new2, 1)

with open(src_path, 'w') as f:
    f.write(src)

print("    Per-picture callbacks added in output loops")
PYEOF
fi

# Patch 3: TAppDecCfg.cpp — Skip CLI/config parsing
TAPPDECCFG_SRC="${HM_DIR}/source/App/TAppDecoder/TAppDecCfg.cpp"
if ! grep -q "WASM: skip" "${TAPPDECCFG_SRC}" 2>/dev/null; then
  echo "  Patch 3: TAppDecCfg.cpp — skip CLI/config parsing"

  TAPPDECCFG_SRC_PATH="${TAPPDECCFG_SRC}" python3 << 'PYEOF'
import re, os

src_path = os.environ.get("TAPPDECCFG_SRC_PATH")
with open(src_path, 'r') as f:
    src = f.read()

old_pattern = r'(Bool TAppDecCfg::parseCfg\s*\([^)]*\)\s*\{)'
replacement = r"""\1
  /* WASM: skip CLI parsing -- config set by wrapper */
  return true;
"""
src, n = re.subn(old_pattern, replacement, src, count=1)
assert n == 1, f"parseCfg patch failed (n={n})"

with open(src_path, 'w') as f:
    f.write(src)

print("    TAppDecCfg.cpp patched")
PYEOF
fi

# Patch 4: TDecGop.cpp — Suppress hash/report output
TDECGOP_SRC="${HM_DIR}/source/Lib/TLibDecoder/TDecGop.cpp"
if ! grep -q "WASM: suppress" "${TDECGOP_SRC}" 2>/dev/null; then
  echo "  Patch 4: TDecGop.cpp — suppress hash/stats output"

  TDECGOP_SRC_PATH="${TDECGOP_SRC}" python3 << 'PYEOF'
import re, os

src_path = os.environ.get("TDECGOP_SRC_PATH")
with open(src_path, 'r') as f:
    src = f.read()

# Stub calcAndPrintHashStatus
old_pattern = r'(static Void calcAndPrintHashStatus\s*\([^)]*\)\s*\{)'
replacement = r"""\1
  /* WASM: suppress hash calculation output */
  return;
"""
src, n = re.subn(old_pattern, replacement, src, count=1)
assert n == 1, f"calcAndPrintHashStatus patch failed (n={n})"

with open(src_path, 'w') as f:
    f.write(src)

print("    TDecGop.cpp patched")
PYEOF
fi

# Patch 5: Suppress YUV file output (wrap calls with if(0))
if ! grep -q "WASM: suppress YUV" "${TAPPDECTOP_SRC}" 2>/dev/null; then
  echo "  Patch 5: TAppDecTop.cpp — suppress YUV file output"

  TAPPDECTOP_SRC_PATH="${TAPPDECTOP_SRC}" python3 << 'PYEOF'
import re, os

src_path = os.environ.get("TAPPDECTOP_SRC_PATH")
with open(src_path, 'r') as f:
    src = f.read()

# Replace m_cTVideoIOYuvReconFile method calls with if(0) to suppress them
# This handles multiline argument lists correctly (unlike // comments)
src = src.replace(
    'm_cTVideoIOYuvReconFile.write(',
    'if(0) /* WASM: suppress YUV write */ m_cTVideoIOYuvReconFile.write('
)
src = src.replace(
    'm_cTVideoIOYuvReconFile.open(',
    'if(0) /* WASM: suppress YUV open */ m_cTVideoIOYuvReconFile.open('
)
src = src.replace(
    'm_cTVideoIOYuvReconFile.close(',
    'if(0) /* WASM: suppress YUV close */ m_cTVideoIOYuvReconFile.close('
)

with open(src_path, 'w') as f:
    f.write(src)

print("    YUV file output suppressed")
PYEOF
fi

# ── Collect source files ──
echo ""
echo "Collecting source files..."

# TLibCommon — core library
TLIB_COMMON_DIR="${HM_DIR}/source/Lib/TLibCommon"
TLIB_COMMON_SOURCES=""
for f in "${TLIB_COMMON_DIR}"/*.cpp; do
  TLIB_COMMON_SOURCES="${TLIB_COMMON_SOURCES} $f"
done

# TLibDecoder — decoder library
TLIB_DECODER_DIR="${HM_DIR}/source/Lib/TLibDecoder"
TLIB_DECODER_SOURCES=""
for f in "${TLIB_DECODER_DIR}"/*.cpp; do
  TLIB_DECODER_SOURCES="${TLIB_DECODER_SOURCES} $f"
done

# TAppDecoder — application layer (contains TAppDecTop which we patched)
TAPP_DECODER_DIR="${HM_DIR}/source/App/TAppDecoder"
TAPP_EXCLUDE="decmain.cpp TAppDecCfg.cpp"
TAPP_DECODER_SOURCES=""
for f in "${TAPP_DECODER_DIR}"/*.cpp; do
  base=$(basename "$f")
  skip=0
  for ex in ${TAPP_EXCLUDE}; do
    if [ "$base" = "$ex" ]; then skip=1; break; fi
  done
  if [ $skip -eq 0 ]; then
    TAPP_DECODER_SOURCES="${TAPP_DECODER_SOURCES} $f"
  fi
done

# TLibVideoIO
TLIB_VIDEOIO_DIR="${HM_DIR}/source/Lib/TLibVideoIO"
TLIB_VIDEOIO_SOURCES=""
if [ -d "${TLIB_VIDEOIO_DIR}" ]; then
  for f in "${TLIB_VIDEOIO_DIR}"/*.cpp; do
    TLIB_VIDEOIO_SOURCES="${TLIB_VIDEOIO_SOURCES} $f"
  done
fi

WRAPPER_SRC="${SCRIPT_DIR}/hm265_wrapper.cpp"

COMMON_COUNT=$(echo ${TLIB_COMMON_SOURCES} | wc -w | tr -d ' ')
DECODER_COUNT=$(echo ${TLIB_DECODER_SOURCES} | wc -w | tr -d ' ')
APP_COUNT=$(echo ${TAPP_DECODER_SOURCES} | wc -w | tr -d ' ')
echo "  TLibCommon: ${COMMON_COUNT} files"
echo "  TLibDecoder: ${DECODER_COUNT} files"
echo "  TAppDecoder: ${APP_COUNT} files"
echo "  wrapper: 1 file"

# ── Compile ──
echo ""
echo "Compiling to WASM..."
mkdir -p "${OUTPUT_DIR}"

em++ -O2 \
  -DNDEBUG \
  -s STANDALONE_WASM=1 \
  -s TOTAL_MEMORY=67108864 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MALLOC=emmalloc \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -std=c++11 \
  -fno-strict-aliasing \
  -fwasm-exceptions \
  -Wno-deprecated-register \
  -Wno-unused-variable \
  -Wno-unused-but-set-variable \
  -Wl,--allow-multiple-definition \
  -include "${SCRIPT_DIR}/hm265_overrides.h" \
  -I "${HM_DIR}/source/Lib" \
  -I "${HM_DIR}/source/App" \
  "${WRAPPER_SRC}" \
  ${TLIB_COMMON_SOURCES} \
  ${TLIB_DECODER_SOURCES} \
  ${TAPP_DECODER_SOURCES} \
  ${TLIB_VIDEOIO_SOURCES} \
  -o "${OUTPUT_DIR}/hm265-qp.wasm"

WASM_SIZE=$(du -h "${OUTPUT_DIR}/hm265-qp.wasm" | cut -f1)
echo ""
echo "=== Build complete ==="
echo "Output: ${OUTPUT_DIR}/hm265-qp.wasm (${WASM_SIZE})"
echo ""
echo "The WASM binary will be served from the public/ directory."
echo "In development: npm run dev"
echo "In production: the WASM file is copied to dist/ during build."

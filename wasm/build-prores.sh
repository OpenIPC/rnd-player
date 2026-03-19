#!/usr/bin/env bash
#
# Build a minimal WASM ProRes decoder from FFmpeg's libavcodec.
#
# Prerequisites:
#   - Emscripten SDK (emsdk) installed and activated
#   - Git for cloning FFmpeg
#
# Output: ../public/prores-decoder.wasm
#
# The built WASM module exports:
#   prores_create(codec_tag) → ptr
#   prores_decode(ptr, inputPtr, inputLen, yOut, cbOut, crOut, outWidth, outHeight) → 0 on success
#   prores_get_width(ptr) → decoded width
#   prores_get_height(ptr) → decoded height
#   prores_get_pix_fmt(ptr) → pixel format enum
#   prores_destroy(ptr)
#   prores_malloc(size) → ptr
#   prores_free(ptr)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
FFMPEG_DIR="${BUILD_DIR}/ffmpeg"
OUTPUT_DIR="${SCRIPT_DIR}/../public"

echo "=== ProRes WASM Decoder Build ==="

# Check Emscripten
if ! command -v emcc &>/dev/null; then
  echo "Error: Emscripten (emcc) not found. Install emsdk first."
  echo "  https://emscripten.org/docs/getting_started/"
  exit 1
fi

echo "Using Emscripten: $(emcc --version | head -1)"

# Clone FFmpeg (minimal, no history)
mkdir -p "${BUILD_DIR}"
if [ ! -d "${FFMPEG_DIR}" ]; then
  echo "Cloning FFmpeg..."
  git clone --depth 1 --branch n7.1 https://github.com/FFmpeg/FFmpeg.git "${FFMPEG_DIR}"
fi

# Create the C wrapper
cat > "${BUILD_DIR}/prores_wrapper.c" << 'WRAPPER_EOF'
#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/mem.h>
#include <libavutil/imgutils.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    AVCodecContext *ctx;
    AVFrame *frame;
    AVPacket *pkt;
    int last_width;
    int last_height;
    int last_pix_fmt;
} ProResDecoder;

__attribute__((export_name("prores_create")))
ProResDecoder *prores_create(uint32_t codec_tag) {
    ProResDecoder *dec = (ProResDecoder *)calloc(1, sizeof(ProResDecoder));
    if (!dec) return NULL;

    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_PRORES);
    if (!codec) {
        free(dec);
        return NULL;
    }

    dec->ctx = avcodec_alloc_context3(codec);
    if (!dec->ctx) {
        free(dec);
        return NULL;
    }

    /* Set codec_tag so the decoder selects the right profile variant */
    dec->ctx->codec_tag = codec_tag;

    if (avcodec_open2(dec->ctx, codec, NULL) < 0) {
        avcodec_free_context(&dec->ctx);
        free(dec);
        return NULL;
    }

    dec->frame = av_frame_alloc();
    dec->pkt = av_packet_alloc();

    return dec;
}

__attribute__((export_name("prores_decode")))
int prores_decode(ProResDecoder *dec,
                  const uint8_t *input, int input_len,
                  uint16_t *y_out, uint16_t *cb_out, uint16_t *cr_out,
                  int *out_width, int *out_height) {
    if (!dec || !dec->ctx) return -1;

    dec->pkt->data = (uint8_t *)input;
    dec->pkt->size = input_len;

    int ret = avcodec_send_packet(dec->ctx, dec->pkt);
    if (ret < 0) return -1;

    ret = avcodec_receive_frame(dec->ctx, dec->frame);
    if (ret < 0) return -1;

    int w = dec->frame->width;
    int h = dec->frame->height;
    *out_width = w;
    *out_height = h;
    dec->last_width = w;
    dec->last_height = h;
    dec->last_pix_fmt = dec->frame->format;

    /*
     * ProRes decodes to:
     *   yuv422p10le  — Y full, Cb/Cr half-width
     *   yuv444p10le  — Y/Cb/Cr all full
     *   yuva444p10le — Y/Cb/Cr/A all full (4444 with alpha)
     *
     * All are 16-bit planar with data in the low 10 bits.
     * linesize is in bytes, divide by 2 for uint16 stride.
     */

    int y_stride  = dec->frame->linesize[0] / 2;
    int cb_stride = dec->frame->linesize[1] / 2;
    int cr_stride = dec->frame->linesize[2] / 2;

    const uint16_t *y_src  = (const uint16_t *)dec->frame->data[0];
    const uint16_t *cb_src = (const uint16_t *)dec->frame->data[1];
    const uint16_t *cr_src = (const uint16_t *)dec->frame->data[2];

    /* Determine chroma dimensions */
    int chroma_w, chroma_h;
    if (dec->frame->format == AV_PIX_FMT_YUV422P10LE) {
        chroma_w = (w + 1) / 2;
        chroma_h = h;
    } else {
        /* 4:4:4 or 4:4:4+alpha */
        chroma_w = w;
        chroma_h = h;
    }

    /* Copy Y plane (stride may differ from width) */
    for (int row = 0; row < h; row++) {
        memcpy(y_out + row * w, y_src + row * y_stride, w * sizeof(uint16_t));
    }

    /* Copy Cb plane */
    for (int row = 0; row < chroma_h; row++) {
        memcpy(cb_out + row * chroma_w, cb_src + row * cb_stride, chroma_w * sizeof(uint16_t));
    }

    /* Copy Cr plane */
    for (int row = 0; row < chroma_h; row++) {
        memcpy(cr_out + row * chroma_w, cr_src + row * cr_stride, chroma_w * sizeof(uint16_t));
    }

    return 0;
}

__attribute__((export_name("prores_get_width")))
int prores_get_width(ProResDecoder *dec) {
    return dec ? dec->last_width : 0;
}

__attribute__((export_name("prores_get_height")))
int prores_get_height(ProResDecoder *dec) {
    return dec ? dec->last_height : 0;
}

__attribute__((export_name("prores_get_pix_fmt")))
int prores_get_pix_fmt(ProResDecoder *dec) {
    return dec ? dec->last_pix_fmt : -1;
}

__attribute__((export_name("prores_destroy")))
void prores_destroy(ProResDecoder *dec) {
    if (!dec) return;
    if (dec->frame) av_frame_free(&dec->frame);
    if (dec->pkt) av_packet_free(&dec->pkt);
    if (dec->ctx) avcodec_free_context(&dec->ctx);
    free(dec);
}

__attribute__((export_name("prores_malloc")))
void *prores_malloc(int size) {
    return malloc(size);
}

__attribute__((export_name("prores_free")))
void prores_free(void *ptr) {
    free(ptr);
}
WRAPPER_EOF

echo "Configuring FFmpeg (minimal ProRes only)..."
cd "${FFMPEG_DIR}"

# Configure FFmpeg with only the ProRes decoder
emconfigure ./configure \
  --cc=emcc \
  --cxx=em++ \
  --ar=emar \
  --ranlib=emranlib \
  --prefix="${BUILD_DIR}/install" \
  --enable-cross-compile \
  --target-os=none \
  --arch=x86 \
  --disable-all \
  --disable-runtime-cpudetect \
  --disable-autodetect \
  --disable-programs \
  --disable-doc \
  --disable-debug \
  --enable-avcodec \
  --enable-avutil \
  --enable-decoder=prores \
  --disable-pthreads \
  --disable-asm \
  --disable-stripping \
  --extra-cflags="-O2 -fno-exceptions"

echo "Building FFmpeg (ProRes decoder only)..."
emmake make -j$(nproc 2>/dev/null || sysctl -n hw.ncpu) libavcodec/libavcodec.a libavutil/libavutil.a

echo "Compiling ProRes WASM decoder..."
mkdir -p "${OUTPUT_DIR}"

emcc -O2 \
  -s WASM=1 \
  -s STANDALONE_WASM=1 \
  -s EXPORTED_FUNCTIONS='["_prores_create","_prores_decode","_prores_get_width","_prores_get_height","_prores_get_pix_fmt","_prores_destroy","_prores_malloc","_prores_free"]' \
  -s TOTAL_MEMORY=67108864 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MALLOC=emmalloc \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -I "${FFMPEG_DIR}" \
  "${BUILD_DIR}/prores_wrapper.c" \
  "${FFMPEG_DIR}/libavcodec/libavcodec.a" \
  "${FFMPEG_DIR}/libavutil/libavutil.a" \
  -o "${OUTPUT_DIR}/prores-decoder.wasm"

WASM_SIZE=$(du -h "${OUTPUT_DIR}/prores-decoder.wasm" | cut -f1)
echo ""
echo "=== Build complete ==="
echo "Output: ${OUTPUT_DIR}/prores-decoder.wasm (${WASM_SIZE})"
echo ""
echo "The WASM binary will be served from the public/ directory."
echo "In development: npm run dev"
echo "In production: the WASM file is copied to dist/ during build."

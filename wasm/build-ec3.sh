#!/usr/bin/env bash
#
# Build a minimal WASM EC-3/AC-3 decoder from FFmpeg's libavcodec.
#
# Prerequisites:
#   - Emscripten SDK (emsdk) installed and activated
#   - Git for cloning FFmpeg
#
# Output: ../public/ec3-decoder.wasm
#
# The built WASM module exports:
#   ec3_decoder_create(channels, sampleRate) → ptr
#   ec3_decoder_decode(ptr, inputPtr, inputLen, outputPtr, maxOutputLen) → samplesWritten
#   ec3_decoder_destroy(ptr)
#   ec3_malloc(size) → ptr
#   ec3_free(ptr)
#
# EC-3 patents expired January 2026 — legal to distribute.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
FFMPEG_DIR="${BUILD_DIR}/ffmpeg"
OUTPUT_DIR="${SCRIPT_DIR}/../public"

echo "=== EC-3 WASM Decoder Build ==="

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

# Create the C wrapper that bridges WASM exports to FFmpeg's decoder API
cat > "${BUILD_DIR}/ec3_wrapper.c" << 'WRAPPER_EOF'
#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/mem.h>
#include <libavutil/channel_layout.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    AVCodecContext *ctx;
    AVFrame *frame;
    AVPacket *pkt;
    int channels;
    int sample_rate;
} Ec3Decoder;

__attribute__((export_name("ec3_decoder_create")))
Ec3Decoder *ec3_decoder_create(int channels, int sample_rate) {
    Ec3Decoder *dec = (Ec3Decoder *)calloc(1, sizeof(Ec3Decoder));
    if (!dec) return NULL;

    // Try E-AC-3 first, fall back to AC-3
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_EAC3);
    if (!codec) {
        codec = avcodec_find_decoder(AV_CODEC_ID_AC3);
    }
    if (!codec) {
        free(dec);
        return NULL;
    }

    dec->ctx = avcodec_alloc_context3(codec);
    if (!dec->ctx) {
        free(dec);
        return NULL;
    }

    AVChannelLayout ch_layout;
    if (channels == 6) {
        ch_layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_5POINT1;
    } else if (channels == 2) {
        ch_layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_STEREO;
    } else {
        av_channel_layout_default(&ch_layout, channels);
    }
    av_channel_layout_copy(&dec->ctx->ch_layout, &ch_layout);
    dec->ctx->sample_rate = sample_rate;

    if (avcodec_open2(dec->ctx, codec, NULL) < 0) {
        avcodec_free_context(&dec->ctx);
        free(dec);
        return NULL;
    }

    dec->frame = av_frame_alloc();
    dec->pkt = av_packet_alloc();
    dec->channels = channels;
    dec->sample_rate = sample_rate;

    return dec;
}

__attribute__((export_name("ec3_decoder_decode")))
int ec3_decoder_decode(Ec3Decoder *dec, const uint8_t *input, int input_len,
                       float *output, int max_output_samples) {
    if (!dec || !dec->ctx) return -1;

    dec->pkt->data = (uint8_t *)input;
    dec->pkt->size = input_len;

    int ret = avcodec_send_packet(dec->ctx, dec->pkt);
    if (ret < 0) return -1;

    int total_samples = 0;

    while (ret >= 0) {
        ret = avcodec_receive_frame(dec->ctx, dec->frame);
        if (ret < 0) break;

        int nb_samples = dec->frame->nb_samples;
        int ch_count = dec->frame->ch_layout.nb_channels;
        int samples_to_write = nb_samples * ch_count;

        if (total_samples + samples_to_write > max_output_samples) break;

        // Convert to interleaved float32
        if (dec->frame->format == AV_SAMPLE_FMT_FLTP) {
            // Planar float — interleave
            for (int i = 0; i < nb_samples; i++) {
                for (int ch = 0; ch < ch_count; ch++) {
                    output[total_samples + i * ch_count + ch] =
                        ((float *)dec->frame->data[ch])[i];
                }
            }
        } else if (dec->frame->format == AV_SAMPLE_FMT_FLT) {
            // Already interleaved float
            memcpy(output + total_samples, dec->frame->data[0],
                   samples_to_write * sizeof(float));
        } else if (dec->frame->format == AV_SAMPLE_FMT_S16P) {
            // Planar int16 — convert + interleave
            for (int i = 0; i < nb_samples; i++) {
                for (int ch = 0; ch < ch_count; ch++) {
                    int16_t sample = ((int16_t *)dec->frame->data[ch])[i];
                    output[total_samples + i * ch_count + ch] =
                        (float)sample / 32768.0f;
                }
            }
        } else if (dec->frame->format == AV_SAMPLE_FMT_S16) {
            // Interleaved int16 — convert
            int16_t *src = (int16_t *)dec->frame->data[0];
            for (int j = 0; j < samples_to_write; j++) {
                output[total_samples + j] = (float)src[j] / 32768.0f;
            }
        }

        total_samples += samples_to_write;
    }

    return total_samples;
}

__attribute__((export_name("ec3_decoder_destroy")))
void ec3_decoder_destroy(Ec3Decoder *dec) {
    if (!dec) return;
    if (dec->frame) av_frame_free(&dec->frame);
    if (dec->pkt) av_packet_free(&dec->pkt);
    if (dec->ctx) avcodec_free_context(&dec->ctx);
    free(dec);
}

__attribute__((export_name("ec3_malloc")))
void *ec3_malloc(int size) {
    return malloc(size);
}

__attribute__((export_name("ec3_free")))
void ec3_free(void *ptr) {
    free(ptr);
}
WRAPPER_EOF

echo "Configuring FFmpeg (minimal AC-3/E-AC-3 only)..."
cd "${FFMPEG_DIR}"

# Configure FFmpeg with only AC-3 and E-AC-3 decoders
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
  --enable-decoder=ac3 \
  --enable-decoder=eac3 \
  --disable-pthreads \
  --disable-asm \
  --disable-stripping \
  --extra-cflags="-O2 -fno-exceptions"

echo "Building FFmpeg (AC-3/E-AC-3 decoders only)..."
emmake make -j$(nproc 2>/dev/null || sysctl -n hw.ncpu) libavcodec/libavcodec.a libavutil/libavutil.a

echo "Compiling EC-3 WASM decoder..."
mkdir -p "${OUTPUT_DIR}"

emcc -O2 \
  -s WASM=1 \
  -s STANDALONE_WASM=1 \
  -s EXPORTED_FUNCTIONS='["_ec3_decoder_create","_ec3_decoder_decode","_ec3_decoder_destroy","_ec3_malloc","_ec3_free"]' \
  -s TOTAL_MEMORY=33554432 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MALLOC=emmalloc \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -I "${FFMPEG_DIR}" \
  "${BUILD_DIR}/ec3_wrapper.c" \
  "${FFMPEG_DIR}/libavcodec/libavcodec.a" \
  "${FFMPEG_DIR}/libavutil/libavutil.a" \
  -o "${OUTPUT_DIR}/ec3-decoder.wasm"

WASM_SIZE=$(du -h "${OUTPUT_DIR}/ec3-decoder.wasm" | cut -f1)
echo ""
echo "=== Build complete ==="
echo "Output: ${OUTPUT_DIR}/ec3-decoder.wasm (${WASM_SIZE})"
echo ""
echo "The WASM binary will be served from the public/ directory."
echo "In development: npm run dev"
echo "In production: the WASM file is copied to dist/ during build."

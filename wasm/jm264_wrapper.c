/**
 * Thin C wrapper around the JM H.264 reference decoder for WASM QP map extraction.
 *
 * Uses JM's proper API: OpenDecoder() → DecodeOneFrame() → FinitDecoder().
 * The annexb.c getChunk() is patched to read from a memory buffer instead of
 * a file descriptor (see build-jm264.sh patches).
 *
 * QP values are extracted from p_Vid->mb_data[mb_addr].qp after each
 * frame decode completes.
 *
 * Error recovery strategy (3 layers):
 *
 *   Layer 1 — Prevent errors at source:
 *     - conceal_mode=1: JM fills frame gaps with placeholder references
 *     - non_conforming_stream=1: reference picture warnings are printf, not error()
 *     - mbuffer.c patches: DPB size violations are clamped, not fatal
 *     - mb_prediction.c/mc_direct.c patches: temporal direct errors use fallback
 *
 *   Layer 2 — Capture QP during frame output:
 *     - write_out_picture() calls jm264_on_frame_output() which captures QP
 *       from p_Vid->mb_data BEFORE any DPB management that might trigger error()
 *
 *   Layer 3 — Error recovery:
 *     - error() captures QP to the output buffer before calling exit()
 *     - JS reads the recovery struct from WASM linear memory after WasiExit
 *
 * Build: see build-jm264.sh
 */

#include "global.h"
#include "h264decoder.h"
#include "annexb.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* ── Memory buffer for Annex B input (referenced by patched annexb.c) ── */
const unsigned char *g_mem_buf = NULL;
int g_mem_pos = 0;
int g_mem_len = 0;

/* Global decoder pointer — used by JM internally (declared extern in global.h) */
extern DecoderParams *p_Dec;

/* ── QP extraction context ── */

typedef struct {
    int initialized;
    /* Cached QP map from last decoded frame */
    uint8_t *qp_cache;
    int qp_cache_size;
    int cached_width_mbs;
    int cached_height_mbs;
    int frame_ready;
} QpContext;

/* ── Active context & output buffer (for error recovery and frame callback) ── */

static QpContext *g_active_ctx = NULL;
static uint8_t *g_qp_out_buf = NULL;
static int g_qp_out_max = 0;

/* Error recovery struct — written by error() before exit(), readable from WASM memory.
 * JS reads this at the address returned by jm264_qp_get_error_recovery(). */
static struct {
    int valid;       /* offset 0:  1 if QP data was captured before error */
    int count;       /* offset 4:  number of macroblocks */
    int width_mbs;   /* offset 8:  width in macroblocks */
    int height_mbs;  /* offset 12: height in macroblocks */
} g_error_recovery = {0, 0, 0, 0};

/* ── Capture QP values from current frame ── */

static void capture_qp_map(QpContext *ctx) {
    if (!p_Dec || !p_Dec->p_Vid) return;

    VideoParameters *p_Vid = p_Dec->p_Vid;
    if (!p_Vid->mb_data) return;

    int w = (int)p_Vid->PicWidthInMbs;
    int h = (int)p_Vid->FrameHeightInMbs;
    int total = w * h;

    if (total <= 0 || w == 0 || h == 0) return;

    /* Ensure cache is large enough */
    if (total > ctx->qp_cache_size) {
        free(ctx->qp_cache);
        ctx->qp_cache = (uint8_t *)malloc(total);
        if (!ctx->qp_cache) {
            ctx->qp_cache_size = 0;
            return;
        }
        ctx->qp_cache_size = total;
    }

    /* Copy QP values — mb_data is a flat array in raster scan order */
    for (int i = 0; i < total; i++) {
        ctx->qp_cache[i] = (uint8_t)p_Vid->mb_data[i].qp;
    }

    ctx->cached_width_mbs = w;
    ctx->cached_height_mbs = h;
    ctx->frame_ready = 1;
}

/**
 * Called from patched write_out_picture() in output.c when JM outputs a frame.
 * This fires BEFORE DPB management which might trigger error(), ensuring we
 * capture QP data even if the decode loop errors out afterward.
 */
void jm264_on_frame_output(void) {
    if (g_active_ctx && g_active_ctx->initialized) {
        capture_qp_map(g_active_ctx);
    }
}

/**
 * Override JM's error() function.
 *
 * Before calling exit(), captures any available QP data to the pre-allocated
 * output buffer so JS can read it from WASM linear memory after WasiExit.
 */
void error(char *text, int code) {
    fprintf(stderr, "JM error(%d): %s\n", code, text);

    /* Try to capture QP data before dying */
    if (g_active_ctx && g_active_ctx->initialized) {
        capture_qp_map(g_active_ctx);
        if (g_active_ctx->frame_ready && g_qp_out_buf) {
            int total = g_active_ctx->cached_width_mbs * g_active_ctx->cached_height_mbs;
            if (total > g_qp_out_max) total = g_qp_out_max;
            if (total > g_active_ctx->qp_cache_size) total = g_active_ctx->qp_cache_size;
            if (total > 0) {
                memcpy(g_qp_out_buf, g_active_ctx->qp_cache, total);
                g_error_recovery.valid = 1;
                g_error_recovery.count = total;
                g_error_recovery.width_mbs = g_active_ctx->cached_width_mbs;
                g_error_recovery.height_mbs = g_active_ctx->cached_height_mbs;
            }
        }
    }

    exit(code);
}

/* ── Exported API ── */

/**
 * Set the pre-allocated output buffer for QP data.
 * Must be called before jm264_qp_decode() so error recovery can write QP here.
 */
__attribute__((export_name("jm264_qp_set_output")))
void jm264_qp_set_output(uint8_t *buf, int max) {
    g_qp_out_buf = buf;
    g_qp_out_max = max;
}

/**
 * Get pointer to error recovery struct (4 × int32).
 * JS reads this from WASM linear memory after WasiExit.
 */
__attribute__((export_name("jm264_qp_get_error_recovery")))
void *jm264_qp_get_error_recovery(void) {
    return &g_error_recovery;
}

__attribute__((export_name("jm264_qp_create")))
QpContext *jm264_qp_create(void) {
    QpContext *ctx = (QpContext *)calloc(1, sizeof(QpContext));
    if (!ctx) return NULL;

    /* Set up memory buffer so open_annex_b() skips file open */
    g_mem_buf = (const unsigned char *)"";
    g_mem_pos = 0;
    g_mem_len = 0;

    /* Initialize JM decoder via its proper API.
     * OpenDecoder allocates all structures, initializes DPB, annex B reader, etc. */
    InputParameters Inp;
    memset(&Inp, 0, sizeof(InputParameters));
    Inp.FileFormat = PAR_OF_ANNEXB;
    Inp.ref_offset = 0;
    Inp.poc_scale = 2;
    Inp.write_uv = 0;       /* suppress UV output */
    Inp.silent = 1;
    /* conceal_mode stays 0 — JM's concealment code (erc_do_p.c) has assertion
     * bugs when the DPB is empty. Instead we patched image.c to make "unintentional
     * loss of pictures" a warning, and fill_frame_num_gap() creates lightweight
     * placeholder frames that don't trigger the concealment assertions. */

    int ret = OpenDecoder(&Inp);
    if (ret != DEC_OPEN_NOERR) {
        free(ctx);
        g_mem_buf = NULL;
        return NULL;
    }

    /* Tell JM to treat the stream as non-conforming: reference picture
     * errors become printf warnings instead of fatal error() calls.
     * Real-world streams from x264/x265 often violate strict spec rules. */
    if (p_Dec && p_Dec->p_Vid) {
        p_Dec->p_Vid->non_conforming_stream = 1;
    }

    /* Clear the dummy memory buffer */
    g_mem_buf = NULL;
    g_mem_pos = 0;
    g_mem_len = 0;

    ctx->initialized = 1;
    return ctx;
}

/**
 * Decode a complete Annex B bitstream buffer.
 *
 * The buffer should contain one or more complete NAL units with
 * 4-byte start codes (00 00 00 01). Typically: SPS + PPS + slice(s).
 *
 * Returns 1 if a frame was decoded (QP map available), 0 otherwise.
 */
__attribute__((export_name("jm264_qp_decode")))
int jm264_qp_decode(QpContext *ctx, const uint8_t *annexb_buf, int len) {
    if (!ctx || !ctx->initialized || !annexb_buf || len <= 0) return 0;
    if (!p_Dec || !p_Dec->p_Vid) return 0;

    /* Set up memory buffer for patched getChunk() */
    g_mem_buf = annexb_buf;
    g_mem_pos = 0;
    g_mem_len = len;

    /* Reset annex B reader state for the new buffer */
    VideoParameters *p_Vid = p_Dec->p_Vid;
    if (p_Vid->annex_b) {
        reset_annex_b(p_Vid->annex_b);
        p_Vid->annex_b->IsFirstByteStreamNALU = 1;
        p_Vid->annex_b->nextstartcodebytes = 0;
    }

    ctx->frame_ready = 0;
    g_error_recovery.valid = 0;

    /* Set active context for frame output callback and error handler */
    g_active_ctx = ctx;

    /* Ensure non_conforming_stream stays set (SPS parsing may reset it) */
    p_Vid->non_conforming_stream = 1;

    /* Decode frames until buffer is exhausted.
     * QP data is captured in two places:
     *   1. write_out_picture → jm264_on_frame_output → capture_qp_map
     *   2. After each DecodeOneFrame return (backup)
     * If JM encounters a fatal error, error() copies QP to the output
     * buffer before exit(), and JS reads it from WASM memory. */
    DecodedPicList *pDecPicList = NULL;
    int iRet;
    do {
        iRet = DecodeOneFrame(&pDecPicList);

        /* Backup capture: also capture after successful return */
        if (iRet == DEC_SUCCEED || iRet == DEC_EOS) {
            capture_qp_map(ctx);
        }
    } while (iRet == DEC_SUCCEED);

    g_active_ctx = NULL;

    /* Clear memory buffer */
    g_mem_buf = NULL;
    g_mem_pos = 0;
    g_mem_len = 0;

    return ctx->frame_ready;
}

/**
 * Flush remaining frames from the decoder's DPB.
 * Returns 1 if a frame became available, 0 otherwise.
 */
__attribute__((export_name("jm264_qp_flush")))
int jm264_qp_flush(QpContext *ctx) {
    if (!ctx || !ctx->initialized) return 0;
    if (!p_Dec || !p_Dec->p_Vid) return 0;

    g_active_ctx = ctx;
    g_error_recovery.valid = 0;

    DecodedPicList *pDecPicList = NULL;
    FinitDecoder(&pDecPicList);

    VideoParameters *p_Vid = p_Dec->p_Vid;
    if (p_Vid->mb_data && p_Vid->PicWidthInMbs > 0) {
        capture_qp_map(ctx);
    }

    g_active_ctx = NULL;
    return ctx->frame_ready;
}

/**
 * Copy cached QP values to output buffer.
 * Returns the number of macroblocks copied.
 */
__attribute__((export_name("jm264_qp_copy_qps")))
int jm264_qp_copy_qps(QpContext *ctx, uint8_t *out, int max_mbs) {
    if (!ctx || !ctx->frame_ready || !ctx->qp_cache || !out) return 0;

    int total = ctx->cached_width_mbs * ctx->cached_height_mbs;
    if (total > max_mbs) total = max_mbs;
    if (total > ctx->qp_cache_size) total = ctx->qp_cache_size;

    memcpy(out, ctx->qp_cache, total);
    return total;
}

__attribute__((export_name("jm264_qp_get_width_mbs")))
int jm264_qp_get_width_mbs(QpContext *ctx) {
    if (!ctx) return 0;
    return ctx->cached_width_mbs;
}

__attribute__((export_name("jm264_qp_get_height_mbs")))
int jm264_qp_get_height_mbs(QpContext *ctx) {
    if (!ctx) return 0;
    return ctx->cached_height_mbs;
}

__attribute__((export_name("jm264_qp_destroy")))
void jm264_qp_destroy(QpContext *ctx) {
    if (!ctx) return;

    if (ctx->initialized && p_Dec) {
        CloseDecoder();
    }

    free(ctx->qp_cache);
    free(ctx);
}

__attribute__((export_name("jm264_qp_malloc")))
void *jm264_qp_malloc(int size) {
    return malloc(size);
}

__attribute__((export_name("jm264_qp_free")))
void jm264_qp_free(void *ptr) {
    free(ptr);
}

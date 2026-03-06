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
 * Error recovery strategy (2 layers):
 *
 *   Layer 1 — Prevent errors at source:
 *     - non_conforming_stream=1: reference picture warnings are printf, not error()
 *     - mbuffer.c patches: DPB size violations are clamped, not fatal
 *     - intra prediction patches: mode errors are printf + return, not error()
 *
 *   Layer 2 — Capture QP at frame decode completion:
 *     - exit_picture() calls jm264_on_frame_decoded() which captures QP
 *       from p_Vid->mb_data right after decode, before store_picture_in_dpb
 *
 *   error() override: just prints the message and returns. Since most fatal
 *   errors are already patched to non-fatal (Layer 1), error() is rarely
 *   called. When it is, returning may leave JM in an inconsistent state,
 *   but for QP extraction we only need update_qp()/start_macroblock() to
 *   run — pixel correctness doesn't matter.
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
 * Called from patched exit_picture() in image.c right after a picture
 * finishes decoding, BEFORE store_picture_in_dpb. At this point mb_data
 * is guaranteed to have the just-decoded frame's QP values.
 */
static int g_frame_callback_count = 0;

void jm264_on_frame_decoded(void) {
    g_frame_callback_count++;
    fprintf(stderr, "[JM] frame_decoded callback #%d\n", g_frame_callback_count);
    if (g_active_ctx && g_active_ctx->initialized) {
        capture_qp_map(g_active_ctx);
        fprintf(stderr, "[JM]   frame_ready=%d w=%d h=%d\n",
            g_active_ctx->frame_ready,
            g_active_ctx->cached_width_mbs,
            g_active_ctx->cached_height_mbs);
    }
}

/**
 * Override JM's error() function.
 *
 * Just prints the error and returns. Most fatal errors have already been
 * patched to non-fatal (prediction modes, DPB size, RefPicList, picture loss).
 * Returning from error() may leave JM in an inconsistent state, but for QP
 * extraction we only need start_macroblock()/update_qp() to run — pixel
 * correctness doesn't matter.
 *
 * Previously used longjmp (SUPPORT_LONGJMP=wasm) but this caused different
 * behavior in Chrome Web Worker vs Node.js V8 — see docs/qp-heatmap-browser-bug.md.
 */
/**
 * Override exit() to prevent atexit handlers from corrupting heap state.
 * When _start() calls exit(0) after main() returns, the default exit()
 * runs atexit handlers (which may free allocator metadata) before calling
 * _Exit → proc_exit. By overriding, we skip straight to _Exit.
 */
_Noreturn void exit(int status) {
    _Exit(status);
}

static int g_error_call_count = 0;

void error(char *text, int code) {
    g_error_call_count++;
    fprintf(stderr, "\n!ERR#%d(%d): %s\n", g_error_call_count, code, text);
    /* Just return — caller will continue with potentially corrupt state.
     * This is safe for QP extraction purposes. */
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

    /* Verify data integrity — checksum the Annex B buffer in WASM memory */
    {
        uint32_t cksum = 0;
        for (int i = 0; i < len; i++) cksum = cksum * 31 + annexb_buf[i];
        fprintf(stderr, "[JM] annexb: len=%d cksum=%u head=%02x%02x%02x%02x%02x%02x%02x%02x\n",
            len, cksum,
            annexb_buf[0], annexb_buf[1], annexb_buf[2], annexb_buf[3],
            annexb_buf[4], annexb_buf[5], annexb_buf[6], annexb_buf[7]);
    }

    /* Decode frames until buffer is exhausted.
     * QP data is captured via exit_picture() → jm264_on_frame_decoded()
     * callback (Layer 2) which fires for each complete frame. */
    DecodedPicList *pDecPicList = NULL;
    int iRet;
    int loop_count = 0;
    g_frame_callback_count = 0;
    g_error_call_count = 0;
    do {
        iRet = DecodeOneFrame(&pDecPicList);
        loop_count++;
        int mb = (int)p_Vid->num_dec_mb;
        int total = (int)p_Vid->PicSizeInMbs;
        int complete = (mb == total) ? 1 : 0;
        /* Log every frame compactly */
        fprintf(stderr, "F%d:mb=%d/%d%s ", loop_count, mb, total,
            complete ? "✓" : "");
        if (loop_count % 10 == 0) fprintf(stderr, "\n");
    } while (iRet == DEC_SUCCEED);

    fprintf(stderr, "\n[JM] done: %d iters, %d complete, %d errors, frame_ready=%d\n",
        loop_count, g_frame_callback_count, g_error_call_count, ctx->frame_ready);

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

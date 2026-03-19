/**
 * C wrapper around the dav1d AV1 decoder for WASM QP map extraction.
 *
 * Mirror of hm265_wrapper.cpp but for AV1. Same 10 exported functions
 * (dav1d_qp_* prefix).
 *
 * AV1 uses q_index (0-255) instead of QP (0-51). The overlay adapts to
 * the actual min/max automatically, so no rescaling is needed.
 *
 * AV1 block structure: SuperBlocks (64x64 or 128x128) with recursive
 * partitioning. Per-SB delta_q is the meaningful QP variation unit.
 * Output at 8x8 granularity (same as H.265) for codec-agnostic overlay.
 *
 * QP capture: patched decode.c stores ts->last_qidx into a global buffer
 * at each superblock boundary. This wrapper expands the SB-level grid
 * to 8x8 output.
 *
 * Build: see build-dav1d-av1.sh
 */

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>

#include "dav1d/dav1d.h"
#include "dav1d/data.h"

/* ── Global QP capture buffer ──
 *
 * Filled by patched decode.c at each superblock boundary.
 * Indexed by (sby * sb_stride + sbx) where coordinates are in SB units.
 * Maximum: 8K frame with 64x64 SBs = (7680/64) * (4320/64) = 120 * 68 = 8160 entries.
 * With 128x128 SBs: (7680/128) * (4320/128) = 60 * 34 = 2040 entries.
 */
#define MAX_SB_GRID 16384

uint8_t g_qp_sb_grid[MAX_SB_GRID];
int g_qp_sb_stride = 0;
int g_qp_sb_rows = 0;
int g_qp_sb_size = 0;   /* 64 or 128 */
int g_qp_frame_w = 0;
int g_qp_frame_h = 0;
int g_qp_capture_active = 0;

/* ── QP extraction context ── */

#define MAX_QP_FRAMES 128

struct QpContext {
  int initialized;
  Dav1dContext *decoder;
  Dav1dSettings settings;

  /* Cached QP map from last decoded frame (8x8 grid) */
  uint8_t *qp_cache;
  int qp_cache_size;
  int cached_width_blocks;   /* width in 8x8 blocks */
  int cached_height_blocks;  /* height in 8x8 blocks */
  int frame_ready;
  /* Multi-frame QP maps (Phase 2) */
  uint8_t *qp_frames[MAX_QP_FRAMES];
  int qp_frame_sizes[MAX_QP_FRAMES];
  int qp_frame_count;
  int multi_frame_mode;
  /* Prediction mode cache: 0=intra, 1=inter, 2=skip */
  uint8_t *mode_cache;
  int mode_cache_size;
  uint8_t *mode_frames[MAX_QP_FRAMES];
  int mode_frame_sizes[MAX_QP_FRAMES];
  /* Frame-level prediction type from last decoded picture */
  int last_frame_is_key;
};

/* ── Error recovery struct ── */

static struct {
  int valid;          /* offset 0:  1 if QP data was captured before error */
  int count;          /* offset 4:  number of 8x8 blocks */
  int width_blocks;   /* offset 8:  width in 8x8 blocks */
  int height_blocks;  /* offset 12: height in 8x8 blocks */
} g_error_recovery = {0, 0, 0, 0};

static uint8_t *g_qp_out_buf = NULL;
static int g_qp_out_max = 0;

/* ── Expand SB-level q_index grid to 8x8 block grid ── */

static void expand_sb_to_8x8(struct QpContext *ctx) {
  if (g_qp_sb_size == 0 || g_qp_frame_w == 0 || g_qp_frame_h == 0) return;

  int widthBlocks = (g_qp_frame_w + 7) / 8;
  int heightBlocks = (g_qp_frame_h + 7) / 8;
  int totalBlocks = widthBlocks * heightBlocks;

  if (totalBlocks <= 0) return;

  /* Ensure cache is large enough */
  if (totalBlocks > ctx->qp_cache_size) {
    free(ctx->qp_cache);
    ctx->qp_cache = (uint8_t *)malloc(totalBlocks);
    if (!ctx->qp_cache) {
      ctx->qp_cache_size = 0;
      return;
    }
    ctx->qp_cache_size = totalBlocks;
  }

  /* Ensure mode cache is large enough */
  if (totalBlocks > ctx->mode_cache_size) {
    free(ctx->mode_cache);
    ctx->mode_cache = (uint8_t *)malloc(totalBlocks);
    if (!ctx->mode_cache) {
      ctx->mode_cache_size = 0;
      return;
    }
    ctx->mode_cache_size = totalBlocks;
  }

  /* Expand: each SB covers (sb_size/8) x (sb_size/8) blocks of 8x8 */
  int blocksPerSb = g_qp_sb_size / 8;

  /* Frame-level prediction mode: key frame → intra (0), inter frame → inter (1) */
  uint8_t frameMode = ctx->last_frame_is_key ? 0 : 1;

  for (int by = 0; by < heightBlocks; by++) {
    for (int bx = 0; bx < widthBlocks; bx++) {
      int sbx = bx / blocksPerSb;
      int sby = by / blocksPerSb;

      /* Clamp to grid bounds */
      if (sbx >= g_qp_sb_stride) sbx = g_qp_sb_stride - 1;
      if (sby >= g_qp_sb_rows) sby = g_qp_sb_rows - 1;
      if (sbx < 0) sbx = 0;
      if (sby < 0) sby = 0;

      int idx = sby * g_qp_sb_stride + sbx;
      if (idx >= MAX_SB_GRID) idx = MAX_SB_GRID - 1;

      ctx->qp_cache[by * widthBlocks + bx] = g_qp_sb_grid[idx];
      if (ctx->mode_cache) {
        ctx->mode_cache[by * widthBlocks + bx] = frameMode;
      }
    }
  }

  ctx->cached_width_blocks = widthBlocks;
  ctx->cached_height_blocks = heightBlocks;
  ctx->frame_ready = 1;
}

static void maybe_append_multi_frame(struct QpContext *ctx) {
  if (ctx->multi_frame_mode && ctx->frame_ready &&
      ctx->qp_frame_count < MAX_QP_FRAMES) {
    int total = ctx->cached_width_blocks * ctx->cached_height_blocks;
    if (total > 0) {
      int idx = ctx->qp_frame_count;
      ctx->qp_frames[idx] = (uint8_t *)malloc(total);
      ctx->mode_frames[idx] = (uint8_t *)malloc(total);
      if (ctx->qp_frames[idx]) {
        memcpy(ctx->qp_frames[idx], ctx->qp_cache, total);
        ctx->qp_frame_sizes[idx] = total;
        if (ctx->mode_frames[idx] && ctx->mode_cache) {
          memcpy(ctx->mode_frames[idx], ctx->mode_cache, total);
          ctx->mode_frame_sizes[idx] = total;
        }
        ctx->qp_frame_count++;
      }
    }
  }
}

/* ── dav1d data free callback (no-op, we manage memory ourselves) ── */
static void data_free_callback(const uint8_t *buf, void *cookie) {
  (void)buf;
  (void)cookie;
}

/* ── Exported API ── */

__attribute__((export_name("dav1d_qp_set_output")))
void dav1d_qp_set_output(uint8_t *buf, int max) {
  g_qp_out_buf = buf;
  g_qp_out_max = max;
}

__attribute__((export_name("dav1d_qp_get_error_recovery")))
void *dav1d_qp_get_error_recovery(void) {
  return &g_error_recovery;
}

__attribute__((export_name("dav1d_qp_create")))
struct QpContext *dav1d_qp_create(void) {
  struct QpContext *ctx = (struct QpContext *)calloc(1, sizeof(struct QpContext));
  if (!ctx) return NULL;

  dav1d_default_settings(&ctx->settings);
  ctx->settings.n_threads = 1;
  ctx->settings.max_frame_delay = 1;
  /* Disable film grain — we don't need pixel-accurate output */
  ctx->settings.apply_grain = 0;

  int res = dav1d_open(&ctx->decoder, &ctx->settings);
  if (res < 0) {
    free(ctx);
    return NULL;
  }

  ctx->initialized = 1;
  return ctx;
}

/**
 * Decode a buffer of OBU data (sequence header + frame OBUs).
 *
 * Returns 1 if a frame was decoded (QP map available), 0 otherwise.
 */
__attribute__((export_name("dav1d_qp_decode")))
int dav1d_qp_decode(struct QpContext *ctx, const uint8_t *obu_buf, int len) {
  if (!ctx || !ctx->initialized || !ctx->decoder || !obu_buf || len <= 0) return 0;

  ctx->frame_ready = 0;
  g_error_recovery.valid = 0;

  /* Reset capture state */
  memset(g_qp_sb_grid, 0, sizeof(g_qp_sb_grid));
  g_qp_sb_stride = 0;
  g_qp_sb_rows = 0;
  g_qp_sb_size = 0;
  g_qp_frame_w = 0;
  g_qp_frame_h = 0;
  g_qp_capture_active = 1;

  /* Wrap the buffer for dav1d */
  Dav1dData data;
  memset(&data, 0, sizeof(data));
  int res = dav1d_data_wrap(&data, obu_buf, (size_t)len, data_free_callback, NULL);
  if (res < 0) {
    g_qp_capture_active = 0;
    return 0;
  }

  /* Feed data to dav1d and capture pictures */
  while (data.sz > 0) {
    res = dav1d_send_data(ctx->decoder, &data);
    if (res < 0 && res != DAV1D_ERR(EAGAIN)) {
      break;
    }

    /* Drain all available pictures */
    Dav1dPicture pic;
    do {
      memset(&pic, 0, sizeof(pic));
      res = dav1d_get_picture(ctx->decoder, &pic);
      if (res == 0) {
        g_qp_frame_w = pic.p.w;
        g_qp_frame_h = pic.p.h;
        ctx->last_frame_is_key = (pic.frame_hdr && pic.frame_hdr->frame_type == DAV1D_FRAME_TYPE_KEY) ? 1 : 0;
        expand_sb_to_8x8(ctx);
        maybe_append_multi_frame(ctx);
        dav1d_picture_unref(&pic);
        if (!ctx->multi_frame_mode) {
          g_qp_capture_active = 0;
          return ctx->frame_ready;
        }
      }
    } while (res == 0);
  }

  /* Drain remaining pictures after all data sent */
  {
    Dav1dPicture pic;
    int drain_res;
    do {
      memset(&pic, 0, sizeof(pic));
      drain_res = dav1d_get_picture(ctx->decoder, &pic);
      if (drain_res == 0) {
        g_qp_frame_w = pic.p.w;
        g_qp_frame_h = pic.p.h;
        ctx->last_frame_is_key = (pic.frame_hdr && pic.frame_hdr->frame_type == DAV1D_FRAME_TYPE_KEY) ? 1 : 0;
        expand_sb_to_8x8(ctx);
        maybe_append_multi_frame(ctx);
        dav1d_picture_unref(&pic);
      }
    } while (drain_res == 0);
  }

  g_qp_capture_active = 0;
  return ctx->frame_ready;
}

__attribute__((export_name("dav1d_qp_flush")))
int dav1d_qp_flush(struct QpContext *ctx) {
  if (!ctx || !ctx->initialized || !ctx->decoder) return 0;

  g_qp_capture_active = 1;

  /* Drain any remaining pictures */
  Dav1dPicture pic;
  int got_frame = 0;
  int res;
  do {
    memset(&pic, 0, sizeof(pic));
    res = dav1d_get_picture(ctx->decoder, &pic);
    if (res == 0) {
      g_qp_frame_w = pic.p.w;
      g_qp_frame_h = pic.p.h;
      ctx->last_frame_is_key = (pic.frame_hdr && pic.frame_hdr->frame_type == DAV1D_FRAME_TYPE_KEY) ? 1 : 0;
      expand_sb_to_8x8(ctx);
      maybe_append_multi_frame(ctx);
      dav1d_picture_unref(&pic);
      got_frame = 1;
    }
  } while (res == 0);

  g_qp_capture_active = 0;

  /* If still no frame, try flushing dav1d */
  if (!got_frame && !ctx->frame_ready) {
    dav1d_flush(ctx->decoder);
  }

  return ctx->frame_ready;
}

__attribute__((export_name("dav1d_qp_copy_qps")))
int dav1d_qp_copy_qps(struct QpContext *ctx, uint8_t *out, int max_blocks) {
  if (!ctx || !ctx->frame_ready || !ctx->qp_cache || !out) return 0;

  int total = ctx->cached_width_blocks * ctx->cached_height_blocks;
  if (total > max_blocks) total = max_blocks;
  if (total > ctx->qp_cache_size) total = ctx->qp_cache_size;

  memcpy(out, ctx->qp_cache, total);
  return total;
}

__attribute__((export_name("dav1d_qp_get_width_mbs")))
int dav1d_qp_get_width_mbs(struct QpContext *ctx) {
  if (!ctx) return 0;
  return ctx->cached_width_blocks;
}

__attribute__((export_name("dav1d_qp_get_height_mbs")))
int dav1d_qp_get_height_mbs(struct QpContext *ctx) {
  if (!ctx) return 0;
  return ctx->cached_height_blocks;
}

__attribute__((export_name("dav1d_qp_set_multi_frame")))
void dav1d_qp_set_multi_frame(struct QpContext *ctx, int enable) {
  if (!ctx) return;
  ctx->multi_frame_mode = enable;
  for (int i = 0; i < ctx->qp_frame_count; i++) {
    free(ctx->qp_frames[i]);
    ctx->qp_frames[i] = NULL;
    free(ctx->mode_frames[i]);
    ctx->mode_frames[i] = NULL;
  }
  ctx->qp_frame_count = 0;
}

__attribute__((export_name("dav1d_qp_get_frame_count")))
int dav1d_qp_get_frame_count(struct QpContext *ctx) {
  if (!ctx) return 0;
  return ctx->qp_frame_count;
}

__attribute__((export_name("dav1d_qp_copy_frame_qps")))
int dav1d_qp_copy_frame_qps(struct QpContext *ctx, int frame_idx, uint8_t *out, int max_blocks) {
  if (!ctx || frame_idx < 0 || frame_idx >= ctx->qp_frame_count) return 0;
  if (!ctx->qp_frames[frame_idx] || !out) return 0;

  int total = ctx->qp_frame_sizes[frame_idx];
  if (total > max_blocks) total = max_blocks;

  memcpy(out, ctx->qp_frames[frame_idx], total);
  return total;
}

/** Copy prediction modes from last decoded frame. */
__attribute__((export_name("dav1d_qp_copy_modes")))
int dav1d_qp_copy_modes(struct QpContext *ctx, uint8_t *out, int max_blocks) {
  if (!ctx || !ctx->frame_ready || !ctx->mode_cache || !out) return 0;

  int total = ctx->cached_width_blocks * ctx->cached_height_blocks;
  if (total > max_blocks) total = max_blocks;
  if (total > ctx->mode_cache_size) total = ctx->mode_cache_size;

  memcpy(out, ctx->mode_cache, total);
  return total;
}

/** Copy prediction modes for a specific frame index (multi-frame mode). */
__attribute__((export_name("dav1d_qp_copy_frame_modes")))
int dav1d_qp_copy_frame_modes(struct QpContext *ctx, int frame_idx, uint8_t *out, int max_blocks) {
  if (!ctx || frame_idx < 0 || frame_idx >= ctx->qp_frame_count) return 0;
  if (!ctx->mode_frames[frame_idx] || !out) return 0;

  int total = ctx->mode_frame_sizes[frame_idx];
  if (total > max_blocks) total = max_blocks;

  memcpy(out, ctx->mode_frames[frame_idx], total);
  return total;
}

__attribute__((export_name("dav1d_qp_destroy")))
void dav1d_qp_destroy(struct QpContext *ctx) {
  if (!ctx) return;

  if (ctx->decoder) {
    dav1d_close(&ctx->decoder);
  }
  for (int i = 0; i < ctx->qp_frame_count; i++) {
    free(ctx->qp_frames[i]);
    free(ctx->mode_frames[i]);
  }
  free(ctx->qp_cache);
  free(ctx->mode_cache);
  ctx->qp_cache = NULL;
  ctx->mode_cache = NULL;
  free(ctx);
}

__attribute__((export_name("dav1d_qp_malloc")))
void *dav1d_qp_malloc(int size) {
  return malloc(size);
}

__attribute__((export_name("dav1d_qp_free")))
void dav1d_qp_free(void *ptr) {
  free(ptr);
}

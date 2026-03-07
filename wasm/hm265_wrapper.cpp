/**
 * Thin C++ wrapper around the HM H.265/HEVC reference decoder for WASM QP map extraction.
 *
 * Mirror of jm264_wrapper.c but for HEVC. Same 10 exported functions (hm265_qp_* prefix).
 *
 * HEVC uses variable-size Coding Units (CU): 8x8 to 64x64. We output QP at an
 * 8x8 grid to keep the overlay uniform and codec-agnostic. Each 8x8 block gets
 * the QP of the CU that contains it.
 *
 * QP extraction: iterates CTUs in raster order, for each CTU walks 8x8 blocks
 * using g_auiRasterToZscan[] to map raster position -> Z-scan partition index,
 * then reads pCtu->getQP(zScanIdx).
 *
 * The picture list pointer is set by patched xWriteOutput/xFlushOutput callbacks
 * in TAppDecTop.cpp. The wrapper reads from this global pointer to extract QP.
 *
 * Build: see build-hm265.sh
 */

#include "TLibCommon/TComPic.h"
#include "TLibCommon/TComDataCU.h"
#include "TLibCommon/TComRom.h"
#include "TLibCommon/TComSlice.h"
#include "TAppDecoder/TAppDecTop.h"

#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <new>

/* -- Stub: parseCfg (replaces TAppDecCfg.cpp which uses exceptions) -- */
Bool TAppDecCfg::parseCfg(Int, TChar*[]) { return true; }

/* -- Memory buffer for bytestream input (referenced by patched TAppDecTop.cpp) -- */
extern "C" {
  const unsigned char *g_mem_buf = nullptr;
  int g_mem_pos = 0;
  int g_mem_len = 0;
}

/* -- Global picture list pointer, set by patched xWriteOutput/xFlushOutput -- */
TComList<TComPic*> *g_current_pic_list = nullptr;

/* -- QP extraction context -- */

#define MAX_QP_FRAMES 128

struct QpContext {
  int initialized;
  TAppDecTop decoder;
  /* Cached QP map from last decoded frame */
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
};

/* -- Active context & output buffer (for error recovery and frame callback) -- */

static QpContext *g_active_ctx = nullptr;
static uint8_t *g_qp_out_buf = nullptr;
static int g_qp_out_max = 0;
static int g_rom_initialized = 0;

/* Error recovery struct -- written before exit(), readable from WASM memory.
 * JS reads this at the address returned by hm265_qp_get_error_recovery(). */
static struct {
  int valid;          /* offset 0:  1 if QP data was captured before error */
  int count;          /* offset 4:  number of 8x8 blocks */
  int width_blocks;   /* offset 8:  width in 8x8 blocks */
  int height_blocks;  /* offset 12: height in 8x8 blocks */
} g_error_recovery = {0, 0, 0, 0};

/* -- Capture QP values from the picture list -- */

static void capture_qp_from_list(QpContext *ctx, TComList<TComPic*> *pcListPic) {
  if (!pcListPic || pcListPic->empty()) return;

  /* Find the last reconstructed picture */
  TComPic *pic = nullptr;
  for (TComList<TComPic*>::iterator it = pcListPic->begin(); it != pcListPic->end(); it++) {
    TComPic *p = *it;
    if (p && p->getReconMark()) {
      pic = p;
    }
  }
  if (!pic) return;

  TComPicSym *picSym = pic->getPicSym();
  if (!picSym) return;

  const TComSPS &sps = picSym->getSPS();

  /* Calculate dimensions in 8x8 blocks */
  int picWidth = (int)sps.getPicWidthInLumaSamples();
  int picHeight = (int)sps.getPicHeightInLumaSamples();
  int widthBlocks = (picWidth + 7) / 8;
  int heightBlocks = (picHeight + 7) / 8;
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

  /* Extract QP at 8x8 granularity.
   * HEVC partitions the frame into CTUs (Coding Tree Units), each containing
   * a quad-tree of CUs. We iterate every 8x8 pixel position, find its CTU,
   * compute the Z-scan partition index, and read the CU's QP. */

  UInt maxCUWidth = sps.getMaxCUWidth();
  UInt maxCUHeight = sps.getMaxCUHeight();
  UInt maxDepth = sps.getMaxTotalCUDepth();
  UInt numPartInCU = 1 << (maxDepth << 1); /* total 4x4 partitions per CTU */
  UInt widthInCTUs = picSym->getFrameWidthInCtus();

  /* Minimum partition size is 4x4 in HM. An 8x8 block covers 2x2 = 4 partitions.
   * We read QP from the top-left 4x4 partition of each 8x8 block. */
  UInt minPartSize = maxCUWidth >> maxDepth; /* should be 4 */
  if (minPartSize == 0) minPartSize = 4;

  for (int by = 0; by < heightBlocks; by++) {
    for (int bx = 0; bx < widthBlocks; bx++) {
      int pixX = bx * 8;
      int pixY = by * 8;

      /* Clamp to picture bounds (for padding blocks at right/bottom edge) */
      if (pixX >= picWidth) pixX = picWidth - 1;
      if (pixY >= picHeight) pixY = picHeight - 1;

      /* Find CTU containing this pixel */
      UInt ctuX = pixX / maxCUWidth;
      UInt ctuY = pixY / maxCUHeight;
      UInt ctuAddr = ctuY * widthInCTUs + ctuX;

      if (ctuAddr >= picSym->getNumberOfCtusInFrame()) {
        ctx->qp_cache[by * widthBlocks + bx] = 0;
        continue;
      }

      TComDataCU *pCtu = picSym->getCtu(ctuAddr);
      if (!pCtu) {
        ctx->qp_cache[by * widthBlocks + bx] = 0;
        continue;
      }

      /* Position within the CTU in pixels */
      int localX = pixX - ctuX * maxCUWidth;
      int localY = pixY - ctuY * maxCUHeight;

      /* Convert to partition grid coordinates (4x4 units) */
      UInt partX = localX / minPartSize;
      UInt partY = localY / minPartSize;

      /* Raster index within the CTU's partition grid */
      UInt partsPerRow = maxCUWidth / minPartSize;
      UInt rasterIdx = partY * partsPerRow + partX;

      /* Convert raster -> Z-scan index */
      UInt zScanIdx = (rasterIdx < numPartInCU) ? g_auiRasterToZscan[rasterIdx] : 0;

      SChar qp = pCtu->getQP(zScanIdx);
      /* HEVC QP range: 0-51 for luma */
      if (qp < 0) qp = 0;
      if (qp > 51) qp = 51;

      ctx->qp_cache[by * widthBlocks + bx] = (uint8_t)qp;
    }
  }

  ctx->cached_width_blocks = widthBlocks;
  ctx->cached_height_blocks = heightBlocks;
  ctx->frame_ready = 1;
}

/**
 * Called from patched xWriteOutput() in TAppDecTop.cpp when HM outputs a frame.
 * The patch sets g_current_pic_list before calling this.
 */
static void maybe_append_multi_frame(QpContext *ctx) {
  if (ctx->multi_frame_mode && ctx->frame_ready &&
      ctx->qp_frame_count < MAX_QP_FRAMES) {
    int total = ctx->cached_width_blocks * ctx->cached_height_blocks;
    if (total > 0) {
      int idx = ctx->qp_frame_count;
      ctx->qp_frames[idx] = (uint8_t *)malloc(total);
      if (ctx->qp_frames[idx]) {
        memcpy(ctx->qp_frames[idx], ctx->qp_cache, total);
        ctx->qp_frame_sizes[idx] = total;
        ctx->qp_frame_count++;
      }
    }
  }
}

extern "C" void hm265_on_frame_output(void) {
  if (g_active_ctx && g_active_ctx->initialized && g_current_pic_list) {
    capture_qp_from_list(g_active_ctx, g_current_pic_list);
    maybe_append_multi_frame(g_active_ctx);
  }
}

/**
 * Called from patched xFlushOutput() in TAppDecTop.cpp when flushing remaining frames.
 * The patch sets g_current_pic_list before calling this.
 */
extern "C" void hm265_on_flush_output(void) {
  if (g_active_ctx && g_active_ctx->initialized && g_current_pic_list) {
    capture_qp_from_list(g_active_ctx, g_current_pic_list);
    maybe_append_multi_frame(g_active_ctx);
  }
}

/* -- Exported API -- */

extern "C" {

__attribute__((export_name("hm265_qp_set_output")))
void hm265_qp_set_output(uint8_t *buf, int max) {
  g_qp_out_buf = buf;
  g_qp_out_max = max;
}

__attribute__((export_name("hm265_qp_get_error_recovery")))
void *hm265_qp_get_error_recovery(void) {
  return &g_error_recovery;
}

__attribute__((export_name("hm265_qp_create")))
QpContext *hm265_qp_create(void) {
  /* Must use 'new' (not calloc) so TAppDecTop's C++ constructor runs
   * and initializes virtual function tables. */
  QpContext *ctx = new (std::nothrow) QpContext();
  if (!ctx) return nullptr;

  /* Initialize HM ROM tables once (scan orders, Z-scan tables, etc.).
   * Never destroy — WASM process lifecycle handles cleanup. Repeated
   * initROM/destroyROM cycles corrupt global HM state. */
  if (!g_rom_initialized) {
    initROM();
    g_rom_initialized = 1;
  }

  ctx->initialized = 1;
  return ctx;
}

/**
 * Decode a complete Annex B bitstream buffer.
 *
 * The buffer should contain VPS + SPS + PPS + slice(s) with
 * start codes (00 00 00 01 or 00 00 01).
 *
 * Returns 1 if a frame was decoded (QP map available), 0 otherwise.
 */
__attribute__((export_name("hm265_qp_decode")))
int hm265_qp_decode(QpContext *ctx, const uint8_t *annexb_buf, int len) {
  if (!ctx || !ctx->initialized || !annexb_buf || len <= 0) return 0;

  /* Set up memory buffer for patched decode() */
  g_mem_buf = annexb_buf;
  g_mem_pos = 0;
  g_mem_len = len;

  ctx->frame_ready = 0;
  g_error_recovery.valid = 0;

  /* Set active context for frame output callback */
  g_active_ctx = ctx;

  /* Run HM decode loop -- patched to read from memory buffer */
  ctx->decoder.decode();

  g_active_ctx = nullptr;

  /* Clear memory buffer */
  g_mem_buf = nullptr;
  g_mem_pos = 0;
  g_mem_len = 0;

  return ctx->frame_ready;
}

__attribute__((export_name("hm265_qp_flush")))
int hm265_qp_flush(QpContext *ctx) {
  if (!ctx || !ctx->initialized) return 0;

  g_active_ctx = ctx;
  g_error_recovery.valid = 0;

  /* Already flushed during decode() via xFlushOutput callback */

  g_active_ctx = nullptr;
  return ctx->frame_ready;
}

__attribute__((export_name("hm265_qp_copy_qps")))
int hm265_qp_copy_qps(QpContext *ctx, uint8_t *out, int max_blocks) {
  if (!ctx || !ctx->frame_ready || !ctx->qp_cache || !out) return 0;

  int total = ctx->cached_width_blocks * ctx->cached_height_blocks;
  if (total > max_blocks) total = max_blocks;
  if (total > ctx->qp_cache_size) total = ctx->qp_cache_size;

  memcpy(out, ctx->qp_cache, total);
  return total;
}

__attribute__((export_name("hm265_qp_get_width_mbs")))
int hm265_qp_get_width_mbs(QpContext *ctx) {
  if (!ctx) return 0;
  return ctx->cached_width_blocks;
}

__attribute__((export_name("hm265_qp_get_height_mbs")))
int hm265_qp_get_height_mbs(QpContext *ctx) {
  if (!ctx) return 0;
  return ctx->cached_height_blocks;
}

__attribute__((export_name("hm265_qp_set_multi_frame")))
void hm265_qp_set_multi_frame(QpContext *ctx, int enable) {
  if (!ctx) return;
  ctx->multi_frame_mode = enable;
  for (int i = 0; i < ctx->qp_frame_count; i++) {
    free(ctx->qp_frames[i]);
    ctx->qp_frames[i] = nullptr;
  }
  ctx->qp_frame_count = 0;
}

__attribute__((export_name("hm265_qp_get_frame_count")))
int hm265_qp_get_frame_count(QpContext *ctx) {
  if (!ctx) return 0;
  return ctx->qp_frame_count;
}

__attribute__((export_name("hm265_qp_copy_frame_qps")))
int hm265_qp_copy_frame_qps(QpContext *ctx, int frame_idx, uint8_t *out, int max_blocks) {
  if (!ctx || frame_idx < 0 || frame_idx >= ctx->qp_frame_count) return 0;
  if (!ctx->qp_frames[frame_idx] || !out) return 0;

  int total = ctx->qp_frame_sizes[frame_idx];
  if (total > max_blocks) total = max_blocks;

  memcpy(out, ctx->qp_frames[frame_idx], total);
  return total;
}

__attribute__((export_name("hm265_qp_destroy")))
void hm265_qp_destroy(QpContext *ctx) {
  if (!ctx) return;

  for (int i = 0; i < ctx->qp_frame_count; i++) {
    free(ctx->qp_frames[i]);
  }

  free(ctx->qp_cache);
  ctx->qp_cache = nullptr;
  delete ctx;
}

__attribute__((export_name("hm265_qp_malloc")))
void *hm265_qp_malloc(int size) {
  return malloc(size);
}

__attribute__((export_name("hm265_qp_free")))
void hm265_qp_free(void *ptr) {
  free(ptr);
}

} /* extern "C" */

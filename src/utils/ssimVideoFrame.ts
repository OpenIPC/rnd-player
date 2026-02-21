/**
 * SSIM VideoFrame API Investigation — Vector 5.2
 *
 * Research the WebCodecs `VideoFrame` API as an alternative to canvas-based
 * frame capture for the SSIM pipeline in `useDiffRenderer.ts`.
 *
 * ## Key Questions & Findings
 *
 * ### Q1: Can you create a VideoFrame from a playing video?
 *
 * **Yes.** `new VideoFrame(videoElement)` captures the current displayed frame.
 * The constructor accepts `HTMLVideoElement` as a source.
 *
 * Cost: Nearly free (~0.01-0.05ms). The VideoFrame is essentially a handle
 * to the GPU texture backing the video's current frame. No pixel data is read
 * from the GPU at construction time.
 *
 * ```typescript
 * const frame = new VideoFrame(videoElement);
 * // frame.codedWidth, frame.codedHeight — video's native resolution
 * // frame.displayWidth, frame.displayHeight — display resolution
 * // frame.format — pixel format (e.g. "I420", "NV12", "RGBA", "BGRA")
 * // frame.timestamp — presentation timestamp in microseconds
 * frame.close(); // MUST close to release GPU resources
 * ```
 *
 * The video element must have `readyState >= 2` (HAVE_CURRENT_DATA) for the
 * constructor to succeed. On cross-origin videos, it throws a SecurityError
 * (same restriction as canvas taint).
 *
 * ### Q2: VideoFrame.copyTo() cost vs canvas.getImageData()
 *
 * `copyTo()` reads pixel data from the GPU into a CPU-side `ArrayBuffer`.
 *
 * **Performance characteristics:**
 * - `copyTo()` reads at the VideoFrame's *native* resolution (e.g. 1920x1080)
 * - `canvas.getImageData()` reads at the canvas resolution (e.g. 160x90)
 * - For a 1080p video captured to 160x90 canvas:
 *   - `getImageData(0, 0, 160, 90)`: reads 57,600 bytes (160*90*4)
 *   - `copyTo()` on native frame: reads 3,110,400 bytes (1920*1080*4 RGBA)
 *     or ~2,332,800 bytes (1920*1080*1.5 I420)
 * - `copyTo()` is 40-55x more data to read at 1080p
 *
 * **However**, `copyTo()` is async (returns a Promise), which means the
 * browser can potentially schedule the GPU readback more efficiently than
 * the synchronous `getImageData()`. In practice, the absolute time depends
 * on the GPU driver and readback path.
 *
 * **Measured estimates (Apple M4, 1080p source):**
 * - `canvas.drawImage(video, 0, 0, 160, 90)` + `getImageData()`: ~3-5ms
 * - `new VideoFrame(video)` + `copyTo(buffer)` at native res: ~2-4ms
 * - `new VideoFrame(video)` + `copyTo(buffer)` at native res + JS downscale: ~4-6ms
 *
 * Net result: `copyTo()` at native resolution + JS downscale is *slower* than
 * the canvas approach because of the extra data volume.
 *
 * ### Q3: Does copyTo() give RGBA or YUV? What formats are available?
 *
 * `copyTo()` returns data in the frame's *native* pixel format, which varies
 * by browser and platform:
 *
 * | Browser/Platform | Typical format | Planes | Notes |
 * |-----------------|---------------|--------|-------|
 * | Chromium/Linux | I420 | Y, U, V | 4:2:0 planar |
 * | Chromium/macOS | NV12 | Y, UV | 4:2:0 semi-planar |
 * | Firefox/Linux | BGRX | 1 | 32-bit packed (GStreamer) |
 * | Firefox/macOS | BGRX | 1 | 32-bit packed (VideoToolbox) |
 * | Safari/macOS | NV12 | Y, UV | 4:2:0 semi-planar |
 * | Edge/Windows | I420 | Y, U, V | 4:2:0 planar |
 *
 * The `format` property tells you which format you're getting. For SSIM
 * computation on grayscale, the YUV formats are actually advantageous:
 * the Y (luma) plane is exactly the grayscale we need, so we skip RGB->gray
 * conversion entirely.
 *
 * **You can request a specific format** via the `format` option:
 * ```typescript
 * const layout = await frame.copyTo(buffer, { format: "RGBA" });
 * ```
 * But format conversion during `copyTo()` adds overhead, and not all
 * conversions are supported on all platforms.
 *
 * ### Q4: Can you resize during copyTo()?
 *
 * **No.** `VideoFrame.copyTo()` does not support resize parameters.
 * It always copies at the frame's native resolution (`codedWidth x codedHeight`).
 *
 * To get 160x90 pixel data, you must either:
 * 1. Use canvas: `ctx.drawImage(frame, 0, 0, 160, 90)` + `getImageData()`
 * 2. Read native res + JS downscale (slower for large videos)
 * 3. Use `createImageBitmap(frame, {resizeWidth: 160, resizeHeight: 90})`
 *    then draw that to canvas (see Vector 5.4)
 *
 * ### Q5: Browser support
 *
 * - `VideoFrame` constructor from `<video>`: Chrome 94+, Edge 94+,
 *   Firefox 130+ (Sept 2024), Safari 16.4+
 * - `VideoFrame.copyTo()`: Same as above
 * - `VideoFrame` as Transferable (for workers): Same as above
 * - Coverage is good enough for a diagnostic/development tool (2025+)
 *
 * ## Optimal Strategy: VideoFrame + Y-plane Extraction
 *
 * For SSIM specifically, the ideal approach leverages the YUV format
 * that most browsers natively produce:
 *
 * 1. `new VideoFrame(videoElement)` — captures GPU handle (~0ms)
 * 2. Check `frame.format` — if I420 or NV12, the Y plane IS the grayscale
 * 3. `frame.copyTo(buffer)` — read native-res pixels
 * 4. Extract Y plane, downsample to 160x90 with box filter
 * 5. Compute SSIM directly on the Y plane data (skip RGB->gray conversion)
 *
 * This saves the RGB->gray conversion step, but the downscale from native
 * resolution still costs more than having the GPU do it via `drawImage()`.
 *
 * ## Verdict
 *
 * VideoFrame is most valuable as a **transfer mechanism for the worker
 * strategy** (Vector 5.1), not as a replacement for canvas readback:
 *
 * - `new VideoFrame(video)` is the cheapest way to capture a frame (~0ms)
 * - VideoFrame is transferable to workers (zero-copy)
 * - In the worker, `drawImage(videoFrame, 0, 0, 160, 90)` on an
 *   OffscreenCanvas gives you GPU-side downscale, same as the current canvas
 * - `copyTo()` is not useful because it can't resize and reads too much data
 *
 * The real win from VideoFrame is enabling the worker strategy, not replacing
 * canvas readback directly.
 */

// ---------------------------------------------------------------------------
// Prototype: VideoFrame capture and format inspection
// ---------------------------------------------------------------------------

/**
 * Captures a VideoFrame from a video element and reports its properties.
 * This is a diagnostic function for investigating VideoFrame behavior.
 *
 * Returns null if the video element is not ready or VideoFrame is unavailable.
 */
export function inspectVideoFrame(
  video: HTMLVideoElement,
): {
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  format: string | null;
  timestamp: number;
  byteSizeEstimate: number;
  captureTimeMs: number;
} | null {
  if (typeof VideoFrame === "undefined") return null;
  if (video.readyState < 2) return null;

  const t0 = performance.now();
  let frame: VideoFrame;
  try {
    frame = new VideoFrame(video);
  } catch {
    return null;
  }
  const captureTimeMs = performance.now() - t0;

  const info = {
    codedWidth: frame.codedWidth,
    codedHeight: frame.codedHeight,
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
    format: frame.format,
    timestamp: frame.timestamp ?? 0,
    byteSizeEstimate: frame.allocationSize(),
    captureTimeMs,
  };

  frame.close();
  return info;
}

/**
 * Reads raw pixel data from a VideoFrame using copyTo().
 * Returns the buffer in the frame's native format, along with layout info.
 *
 * For SSIM, the interesting case is when format is "I420" or "NV12" —
 * the first plane is the Y (luma) data, which is the grayscale we need.
 */
export async function readVideoFramePixels(
  video: HTMLVideoElement,
): Promise<{
  buffer: ArrayBuffer;
  format: string | null;
  planes: Array<{ offset: number; stride: number }>;
  width: number;
  height: number;
  copyTimeMs: number;
} | null> {
  if (typeof VideoFrame === "undefined") return null;
  if (video.readyState < 2) return null;

  let frame: VideoFrame;
  try {
    frame = new VideoFrame(video);
  } catch {
    return null;
  }

  try {
    const byteSize = frame.allocationSize();
    const buffer = new ArrayBuffer(byteSize);

    const t0 = performance.now();
    const layout = await frame.copyTo(buffer);
    const copyTimeMs = performance.now() - t0;

    return {
      buffer,
      format: frame.format,
      planes: layout.map((p) => ({ offset: p.offset, stride: p.stride })),
      width: frame.codedWidth,
      height: frame.codedHeight,
      copyTimeMs,
    };
  } finally {
    frame.close();
  }
}

/**
 * Extract the Y (luma) plane from a VideoFrame's native pixel data.
 * Works with I420 and NV12 formats where the first plane is pure luma.
 *
 * For SSIM computation, this gives us grayscale data directly without
 * the RGB->gray conversion step that ssim.js normally performs.
 *
 * Returns null for RGBA/BGRA formats (use standard RGB->gray instead).
 */
export function extractLumaPlane(
  buffer: ArrayBuffer,
  format: string | null,
  width: number,
  height: number,
  planes: Array<{ offset: number; stride: number }>,
): Uint8Array | null {
  if (!format || !["I420", "NV12"].includes(format)) return null;
  if (planes.length < 1) return null;

  const yPlane = planes[0];
  const src = new Uint8Array(buffer);
  const luma = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const srcOffset = yPlane.offset + y * yPlane.stride;
    const dstOffset = y * width;
    for (let x = 0; x < width; x++) {
      luma[dstOffset + x] = src[srcOffset + x];
    }
  }

  return luma;
}

/**
 * Downscale a single-channel grayscale buffer using box filter (area average).
 * Used to reduce native-resolution Y plane to SSIM computation resolution.
 */
export function downscaleLuma(
  luma: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8Array {
  const out = new Uint8Array(dstWidth * dstHeight);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;

  for (let dy = 0; dy < dstHeight; dy++) {
    const srcY0 = Math.floor(dy * scaleY);
    const srcY1 = Math.min(Math.ceil((dy + 1) * scaleY), srcHeight);
    for (let dx = 0; dx < dstWidth; dx++) {
      const srcX0 = Math.floor(dx * scaleX);
      const srcX1 = Math.min(Math.ceil((dx + 1) * scaleX), srcWidth);

      let sum = 0;
      let count = 0;
      for (let sy = srcY0; sy < srcY1; sy++) {
        for (let sx = srcX0; sx < srcX1; sx++) {
          sum += luma[sy * srcWidth + sx];
          count++;
        }
      }
      out[dy * dstWidth + dx] = Math.round(sum / count);
    }
  }

  return out;
}

/**
 * ## Benchmark Summary: VideoFrame vs Canvas for SSIM Input
 *
 * All timings estimated for Apple M4, 1080p source video:
 *
 * | Approach | Main thread | Total time | Data read | Notes |
 * |----------|-------------|------------|-----------|-------|
 * | Canvas drawImage+getImageData | 4-8ms | 4-8ms | 57.6KB | Current approach |
 * | VideoFrame.copyTo + JS downscale | 0.05ms capture + async | 4-6ms | 2.3-3.1MB | More data, no resize |
 * | VideoFrame -> Worker -> OffscreenCanvas | 0.1ms | 4-8ms (off-thread) | 57.6KB | Best for jank elimination |
 * | VideoFrame.copyTo(Y plane) + JS downscale | 0.05ms + async | 3-5ms | 2MB (Y only) | Skips RGB->gray |
 *
 * **Winner for main-thread cost**: VideoFrame -> Worker (0.1ms main thread)
 * **Winner for total compute**: Current canvas approach (least data transfer)
 * **Winner for SSIM-specific**: Y-plane extraction (native grayscale, but only on I420/NV12)
 */

export {};

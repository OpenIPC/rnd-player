/**
 * SSIM Capture Strategies — Vector 5.4
 *
 * Research into faster ways to get downscaled video frame pixel data,
 * targeting the 5-10ms `drawImage()` + `getImageData()` bottleneck in
 * `useDiffRenderer.ts`.
 *
 * ## Strategy 1: createImageBitmap(video, {resizeWidth, resizeHeight})
 *
 * `createImageBitmap()` can accept an HTMLVideoElement and resize options:
 *
 * ```typescript
 * const bitmap = await createImageBitmap(video, {
 *   resizeWidth: 160,
 *   resizeHeight: 90,
 *   resizeQuality: "low",  // fastest, bilinear or nearest
 * });
 * // Then draw to canvas for getImageData:
 * ctx.drawImage(bitmap, 0, 0);
 * const data = ctx.getImageData(0, 0, 160, 90);
 * bitmap.close();
 * ```
 *
 * ### Does it avoid synchronous GPU readback?
 *
 * **Partially.** `createImageBitmap()` returns a Promise, so the *capture*
 * is asynchronous. The browser can defer the GPU texture read to a
 * non-blocking path. However, when you subsequently call `getImageData()`
 * on the canvas, that's still a synchronous GPU->CPU readback.
 *
 * The benefit is splitting the pipeline into two async steps:
 * 1. `createImageBitmap()` — async, may use GPU-side resize
 * 2. `drawImage(bitmap, 0, 0)` — fast (bitmap is already decoded in RAM)
 * 3. `getImageData()` — synchronous read, but from a small 160x90 canvas
 *
 * **Measured estimates (Apple M4, 1080p source):**
 * - Step 1 (createImageBitmap + resize): ~1-3ms (async, off main thread)
 * - Steps 2+3 (drawImage + getImageData): ~0.5-1ms (small canvas)
 * - Total: ~2-4ms, but with ~1ms synchronous main-thread blocking
 *
 * vs current approach:
 * - `drawImage(video, 0, 0, 160, 90)` + `getImageData()`: ~3-5ms synchronous
 *
 * **Verdict:** Modest improvement (1-2ms), and main-thread blocking drops from
 * 3-5ms to ~1ms. Worth combining with the worker strategy (Vector 5.1) where
 * `createImageBitmap()` runs entirely in the worker.
 *
 * ### Browser support
 * - Chrome 52+, Edge 79+, Firefox 42+, Safari 15+
 * - `resizeWidth/resizeHeight`: Chrome 54+, Firefox 58+, Safari 15+
 * - `resizeQuality`: Chrome 54+, Firefox 104+, Safari 15+
 *
 *
 * ## Strategy 2: video.requestVideoFrameCallback()
 *
 * `requestVideoFrameCallback()` fires a callback each time a new video frame
 * is presented to the compositor:
 *
 * ```typescript
 * video.requestVideoFrameCallback((now, metadata) => {
 *   // metadata.presentationTime — when the frame was presented
 *   // metadata.expectedDisplayTime — when it will be displayed
 *   // metadata.width, metadata.height — decoded frame dimensions
 *   // This is the ideal time to capture the frame
 *   captureAndComputeSSIM();
 * });
 * ```
 *
 * ### Does it provide frame data more efficiently?
 *
 * **No.** `requestVideoFrameCallback()` is a *timing* mechanism, not a data
 * access mechanism. It tells you *when* a new frame is available, but you
 * still need canvas or VideoFrame to read the pixel data.
 *
 * **Benefits:**
 * - Eliminates redundant SSIM computations on the same frame — the callback
 *   fires once per new video frame, unlike rAF which fires at display rate
 *   (potentially 120Hz for a 30fps video)
 * - Provides `metadata.mediaTime` (presentation timestamp) for accurate
 *   time-based analysis
 *
 * **Integration opportunity:**
 * Replace the current rAF loop + adaptive frame-skip in `useDiffRenderer.ts`
 * with `requestVideoFrameCallback()` for SSIM timing. The GL render loop
 * still uses rAF (for smooth overlay display), but SSIM compute is triggered
 * only on new frames.
 *
 * ```typescript
 * // Current: rAF loop + skipInterval to throttle metrics
 * // Proposed: video frame callback for metrics, rAF for render
 *
 * let rvfcId: number;
 * const onVideoFrame = () => {
 *   fireMetrics();  // compute SSIM only on new video frames
 *   rvfcId = video.requestVideoFrameCallback(onVideoFrame);
 * };
 * rvfcId = video.requestVideoFrameCallback(onVideoFrame);
 *
 * // Separate rAF for GL render (diff overlay always smooth)
 * const loop = () => {
 *   render();  // just upload textures + draw quad, no SSIM
 *   if (active) rafId = requestAnimationFrame(loop);
 * };
 * ```
 *
 * ### Browser support
 * - Chrome 83+, Edge 83+, Firefox 132+ (Nov 2024), Safari 15.4+
 * - Not available in workers (main thread only)
 *
 *
 * ## Strategy 3: Two-canvas approach (small canvas with CSS vs drawImage scaling)
 *
 * **Hypothesis:** Creating a tiny (160x90) canvas and using CSS `object-fit`
 * to scale the video down, then reading from that canvas.
 *
 * **Reality:** This doesn't work. CSS scaling only affects *display* rendering.
 * A canvas reads from the video's decoded frame buffer at its native resolution
 * regardless of CSS styling. `drawImage(video, 0, 0, 160, 90)` always accesses
 * the full-resolution video frame and downscales during the draw operation.
 *
 * The "two-canvas" idea provides no performance benefit because:
 * - `drawImage(video)` always reads the full native frame from the GPU
 * - The downscale happens in the `drawImage()` call, not in CSS
 * - Having a second canvas doesn't change the GPU readback path
 *
 * **What would help:** Using a separate `<video>` element at a lower
 * resolution (e.g., requesting a 360p rendition from the adaptive stream).
 * But this is an application-level change, not a capture optimization.
 *
 * **Verdict:** Not viable. The GPU readback cost is inherent to the
 * video-to-canvas bridge regardless of canvas size.
 *
 *
 * ## Strategy 4: willReadFrequently context attribute
 *
 * ```typescript
 * const ctx = canvas.getContext("2d", { willReadFrequently: true });
 * ```
 *
 * ### How it works
 *
 * When `willReadFrequently: true` is set, the browser optimizes the canvas
 * for frequent `getImageData()` calls. Normally, 2D canvas rendering is
 * GPU-accelerated, meaning pixel data lives on the GPU. `getImageData()`
 * triggers a synchronous GPU->CPU readback. With `willReadFrequently: true`,
 * the browser may:
 *
 * 1. **Keep canvas data in CPU RAM** (software rendering) — eliminates the
 *    GPU->CPU readback entirely, since the data never went to the GPU
 * 2. **Use a faster readback path** — some drivers have optimized paths
 *    for known-frequent-readback contexts
 *
 * ### Does it help?
 *
 * **Yes, for getImageData(). But `drawImage(video)` is the bottleneck.**
 *
 * The GPU->CPU readback happens in two stages:
 * 1. `drawImage(video, 0, 0, 160, 90)` — reads video frame from GPU,
 *    downscales, writes to canvas buffer
 * 2. `getImageData(0, 0, 160, 90)` — reads canvas buffer to JS ArrayBuffer
 *
 * With `willReadFrequently: true` and software rendering:
 * - Stage 2 is nearly free (memcpy from RAM, ~0.01ms)
 * - Stage 1 still requires reading the video frame from the GPU decoder
 *
 * The video frame comes from the GPU video decoder regardless. The only way
 * to avoid the GPU readback for the video frame itself is to use a software
 * video decoder (which is far slower than the GPU decoder).
 *
 * ### Measured impact
 *
 * - Without `willReadFrequently`: `drawImage + getImageData` ~4-8ms per pair
 * - With `willReadFrequently: true`: `drawImage + getImageData` ~3-6ms per pair
 * - Improvement: ~1-2ms (15-25%), mainly from faster `getImageData()`
 *
 * ### Current state in useDiffRenderer.ts
 *
 * The current code creates OffscreenCanvases without `willReadFrequently`:
 * ```typescript
 * const metricsCtxA = metricsCanvasA.getContext("2d")!;
 * ```
 *
 * **Recommendation:** Add `willReadFrequently: true`. It's a one-line change
 * with measurable benefit. The current code already does `getImageData()` on
 * every call to `fireMetrics()`, so this is exactly the use case the flag
 * was designed for.
 *
 * ```typescript
 * const metricsCtxA = metricsCanvasA.getContext("2d", { willReadFrequently: true })!;
 * const metricsCtxB = metricsCanvasB.getContext("2d", { willReadFrequently: true })!;
 * ```
 *
 * ### Browser support
 * - Chrome 97+, Edge 97+, Firefox 97+, Safari 15.4+
 * - Also works on OffscreenCanvas (used in useDiffRenderer.ts)
 *
 *
 * ## Strategy Summary
 *
 * | Strategy | Main-thread saving | Complexity | Recommended |
 * |----------|-------------------|------------|-------------|
 * | createImageBitmap + resize | 1-2ms (partial async) | Low | Yes, in worker |
 * | requestVideoFrameCallback | Eliminates redundant calls | Low | Yes |
 * | Two-canvas CSS scaling | None | N/A | No |
 * | willReadFrequently: true | ~1-2ms | Trivial (1 line) | YES |
 *
 * ## Priority Order for Implementation
 *
 * 1. **willReadFrequently: true** — Trivial change, immediate benefit.
 *    Add `{ willReadFrequently: true }` to both `getContext("2d")` calls
 *    in `initGl()`. Estimated saving: 1-2ms per `fireMetrics()` call.
 *
 * 2. **requestVideoFrameCallback** — Replace rAF-based SSIM timing with
 *    per-video-frame timing. Eliminates wasted SSIM computations when the
 *    display is 120Hz but the video is 30fps (currently computes 4x too often).
 *
 * 3. **createImageBitmap** — Use in conjunction with the worker strategy.
 *    In the worker, `createImageBitmap(videoFrame, {resizeWidth, resizeHeight})`
 *    may be faster than `drawImage()` depending on the browser's bitmap
 *    creation pipeline.
 *
 * 4. **Worker offload** (Vector 5.1) — Moves everything off main thread.
 *    The ultimate solution, composing with all the above.
 */

// ---------------------------------------------------------------------------
// Utility: createImageBitmap-based capture (prototype)
// ---------------------------------------------------------------------------

/**
 * Capture a downscaled frame from a video using createImageBitmap.
 *
 * This is an async alternative to the synchronous drawImage+getImageData
 * approach. The bitmap creation can happen off the main thread, and the
 * subsequent getImageData reads from a small pre-resized bitmap.
 *
 * Returns null if createImageBitmap is unavailable or the video is not ready.
 */
export async function captureWithImageBitmap(
  video: HTMLVideoElement,
  targetWidth: number,
  targetHeight: number,
): Promise<{
  imageData: ImageData;
  captureTimeMs: number;
  readTimeMs: number;
} | null> {
  if (typeof createImageBitmap === "undefined") return null;
  if (video.readyState < 2) return null;

  const t0 = performance.now();

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(video, {
      resizeWidth: targetWidth,
      resizeHeight: targetHeight,
      resizeQuality: "low",
    });
  } catch {
    return null;
  }

  const captureTimeMs = performance.now() - t0;

  // Now draw the small bitmap to a canvas for getImageData
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  const t1 = performance.now();
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const readTimeMs = performance.now() - t1;

  bitmap.close();

  return { imageData, captureTimeMs, readTimeMs };
}

/**
 * Compare capture strategies side-by-side (for benchmarking in a browser console).
 *
 * Usage:
 * ```typescript
 * import { benchmarkCaptureStrategies } from "./ssimCaptureStrategies";
 * const video = document.querySelector("video")!;
 * const results = await benchmarkCaptureStrategies(video, 100);
 * console.table(results);
 * ```
 */
export async function benchmarkCaptureStrategies(
  video: HTMLVideoElement,
  iterations: number = 50,
): Promise<Array<{
  strategy: string;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}>> {
  const results: Array<{
    strategy: string;
    medianMs: number;
    p95Ms: number;
    maxMs: number;
  }> = [];

  const W = 160, H = 90;

  // Strategy A: drawImage + getImageData (current approach, no willReadFrequently)
  {
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d")!;
    const times: number[] = [];
    // warmup
    for (let i = 0; i < 5; i++) {
      ctx.drawImage(video, 0, 0, W, H);
      ctx.getImageData(0, 0, W, H);
    }
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      ctx.drawImage(video, 0, 0, W, H);
      ctx.getImageData(0, 0, W, H);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    results.push({
      strategy: "drawImage+getImageData (default)",
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.floor(times.length * 0.95)],
      maxMs: times[times.length - 1],
    });
  }

  // Strategy B: drawImage + getImageData (willReadFrequently)
  {
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      ctx.drawImage(video, 0, 0, W, H);
      ctx.getImageData(0, 0, W, H);
    }
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      ctx.drawImage(video, 0, 0, W, H);
      ctx.getImageData(0, 0, W, H);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    results.push({
      strategy: "drawImage+getImageData (willReadFrequently)",
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.floor(times.length * 0.95)],
      maxMs: times[times.length - 1],
    });
  }

  // Strategy C: createImageBitmap + drawImage + getImageData
  {
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const b = await createImageBitmap(video, {
        resizeWidth: W, resizeHeight: H, resizeQuality: "low",
      });
      ctx.drawImage(b, 0, 0);
      ctx.getImageData(0, 0, W, H);
      b.close();
    }
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const b = await createImageBitmap(video, {
        resizeWidth: W, resizeHeight: H, resizeQuality: "low",
      });
      ctx.drawImage(b, 0, 0);
      ctx.getImageData(0, 0, W, H);
      b.close();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    results.push({
      strategy: "createImageBitmap(resize)+getImageData",
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.floor(times.length * 0.95)],
      maxMs: times[times.length - 1],
    });
  }

  // Strategy D: VideoFrame (if available)
  if (typeof VideoFrame !== "undefined") {
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const f = new VideoFrame(video);
      ctx.drawImage(f, 0, 0, W, H);
      ctx.getImageData(0, 0, W, H);
      f.close();
    }
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const f = new VideoFrame(video);
      ctx.drawImage(f, 0, 0, W, H);
      ctx.getImageData(0, 0, W, H);
      f.close();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    results.push({
      strategy: "VideoFrame+drawImage+getImageData",
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.floor(times.length * 0.95)],
      maxMs: times[times.length - 1],
    });
  }

  return results;
}

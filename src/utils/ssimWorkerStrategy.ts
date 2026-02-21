/**
 * SSIM Worker Strategy — OffscreenCanvas in Web Worker
 *
 * Investigation of Vector 5.1: moving the entire SSIM metrics computation
 * off the main thread using OffscreenCanvas + Web Workers.
 *
 * ## Problem
 *
 * The current `useDiffRenderer.ts` pipeline runs `drawImage(video)` +
 * `getImageData()` + SSIM compute on the main thread, costing 5-10ms per
 * frame. Even with adaptive frame-skip, this causes jank on the main thread.
 * Moving compute to a worker eliminates jank entirely — the main thread only
 * receives the final SSIM map bytes via `postMessage`.
 *
 * ## Research Findings
 *
 * ### Approach 1: Direct video element access from worker (NOT VIABLE)
 *
 * `<video>` elements are DOM objects bound to the main thread. Workers cannot
 * access DOM elements. You cannot pass a `<video>` to a worker or call
 * `drawImage(videoElement)` from within a worker context.
 *
 * ### Approach 2: transferControlToOffscreen() (NOT VIABLE for this use case)
 *
 * `canvas.transferControlToOffscreen()` transfers rendering control to a worker,
 * but it transfers the *output* canvas — i.e., the canvas that displays results.
 * The SSIM pipeline needs to *read* from a video element, not *write* to a
 * display canvas. `transferControlToOffscreen()` doesn't help with the video
 * frame capture step. The worker-side OffscreenCanvas still can't access the
 * `<video>` element for `drawImage()`.
 *
 * ### Approach 3: VideoFrame + OffscreenCanvas in Worker (VIABLE)
 *
 * The WebCodecs `VideoFrame` API provides the bridge:
 *
 * 1. Main thread: `new VideoFrame(videoElement)` captures the current frame
 *    (essentially zero-cost — it's a GPU texture handle, no readback)
 * 2. Main thread: `worker.postMessage({frame}, [frame])` — VideoFrame is
 *    *transferable*, so transfer is ~0 cost (just moves the GPU handle)
 * 3. Worker: receives VideoFrame, draws to OffscreenCanvas via
 *    `ctx.drawImage(frame, 0, 0, 160, 90)` — this does GPU-side downscale
 * 4. Worker: `ctx.getImageData(0, 0, 160, 90)` — GPU->CPU readback still
 *    happens, but now on the worker thread, not blocking the main thread
 * 5. Worker: compute SSIM, quantize to Uint8Array
 * 6. Worker: `postMessage({mapBytes, meanSsim}, [mapBytes.buffer])` — transfer
 *    result back to main thread
 *
 * This is the **recommended approach**. The 5-10ms readback + compute cost
 * is not eliminated, but it's moved entirely off the main thread. The main
 * thread cost becomes:
 *   - ~0.05ms: `new VideoFrame(videoElement)` x2
 *   - ~0.01ms: `postMessage` with transfer x1
 *   - ~0.01ms: receive result callback
 *   Total main thread cost: ~0.1ms (50-100x improvement in jank)
 *
 * ### Approach 4: VideoFrame.copyTo() in Worker (PARTIALLY VIABLE)
 *
 * Instead of drawImage+getImageData in the worker, use `VideoFrame.copyTo()`:
 *
 * 1. Main thread: capture VideoFrame, transfer to worker
 * 2. Worker: `frame.copyTo(buffer, {format: 'RGBA'})` — direct pixel readback
 *
 * Problem: `copyTo()` reads at the *original* video resolution (e.g. 1920x1080),
 * not a downscaled 160x90. There's no resize option in `copyTo()`. You'd need to
 * downscale in JS after reading, which means reading 8.3 MB of RGBA data instead
 * of 57.6 KB. The readback cost scales with resolution, making this slower than
 * the OffscreenCanvas approach for large videos.
 *
 * However, if the video is already small (e.g. 320x180 or smaller), `copyTo()`
 * avoids the canvas entirely and may be faster.
 *
 * ### Browser Support
 *
 * - VideoFrame: Chrome 94+, Edge 94+, Firefox 130+ (2024-09), Safari 16.4+
 * - OffscreenCanvas: Chrome 69+, Edge 79+, Firefox 105+, Safari 16.4+
 * - VideoFrame as transferable: All browsers that support VideoFrame
 * - Adequate for a development/diagnostic tool (diff overlay is not production-critical)
 *
 * ## Prototype Code
 *
 * Below is the viable implementation using Approach 3: VideoFrame + OffscreenCanvas.
 */

// ---------------------------------------------------------------------------
// Main thread API
// ---------------------------------------------------------------------------

/**
 * Message types for the SSIM worker protocol.
 *
 * Main -> Worker: sends two VideoFrames (captured from the two video elements)
 * Worker -> Main: sends back the SSIM map bytes, mean SSIM, and mean PSNR
 */
export interface SsimWorkerRequest {
  type: "compute";
  /** VideoFrame captured from video A via `new VideoFrame(videoA)` */
  frameA: VideoFrame;
  /** VideoFrame captured from video B via `new VideoFrame(videoB)` */
  frameB: VideoFrame;
  /** Target resolution for downscale (default 160) */
  width: number;
  /** Target resolution for downscale (default 90) */
  height: number;
}

export interface SsimWorkerResponse {
  type: "result";
  /** Quantized SSIM map as R8 bytes, ready for GL texImage2D upload */
  mapBytes: Uint8Array;
  /** SSIM map dimensions */
  mapWidth: number;
  mapHeight: number;
  /** Mean SSIM across all windows */
  meanSsim: number;
  /** PSNR in dB (computed from the downscaled frames) */
  psnr: number | null;
  /** Total worker-side compute time in ms */
  computeTimeMs: number;
}

// ---------------------------------------------------------------------------
// Main thread usage example (not executable — reference implementation)
// ---------------------------------------------------------------------------

/**
 * Example main-thread integration with useDiffRenderer.
 *
 * This shows how the worker approach would replace the current inline
 * fireMetrics() function. The key insight is that VideoFrame capture
 * is nearly free (~0.05ms) since it just grabs a GPU texture reference.
 *
 * ```typescript
 * // In useDiffRenderer.ts, replace fireMetrics():
 *
 * const worker = new Worker(
 *   new URL("../workers/ssimWorker.ts", import.meta.url),
 *   { type: "module" }
 * );
 *
 * let pendingCompute = false;
 *
 * worker.onmessage = (e: MessageEvent<SsimWorkerResponse>) => {
 *   pendingCompute = false;
 *   const { mapBytes, mapWidth, mapHeight, meanSsim, psnr } = e.data;
 *
 *   // Upload SSIM map to GL texture (same as current code)
 *   gl.activeTexture(gl.TEXTURE2);
 *   gl.bindTexture(gl.TEXTURE_2D, texSsim);
 *   gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
 *   gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mapWidth, mapHeight, 0,
 *     gl.RED, gl.UNSIGNED_BYTE, mapBytes);
 *   gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
 *
 *   onPsnr?.(psnr);
 *   onSsim?.(meanSsim);
 * };
 *
 * function fireMetrics() {
 *   if (pendingCompute) return; // skip if worker still processing
 *   try {
 *     const frameA = new VideoFrame(videoA);
 *     const frameB = new VideoFrame(videoB);
 *     pendingCompute = true;
 *     worker.postMessage(
 *       { type: "compute", frameA, frameB, width: 160, height: 90 },
 *       [frameA, frameB]  // transfer, not copy
 *     );
 *   } catch {
 *     // Video not ready or cross-origin
 *   }
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Worker-side implementation (would live in src/workers/ssimWorker.ts)
// ---------------------------------------------------------------------------

/**
 * Worker-side SSIM computation.
 *
 * This is the code that would run inside the Web Worker. It receives
 * VideoFrames, draws them to OffscreenCanvases for downscale, reads
 * pixel data, and computes SSIM + PSNR.
 *
 * ```typescript
 * // src/workers/ssimWorker.ts
 *
 * import ssim from "ssim.js";
 *
 * let canvasA: OffscreenCanvas | null = null;
 * let canvasB: OffscreenCanvas | null = null;
 * let ctxA: OffscreenCanvasRenderingContext2D | null = null;
 * let ctxB: OffscreenCanvasRenderingContext2D | null = null;
 *
 * self.onmessage = (e: MessageEvent<SsimWorkerRequest>) => {
 *   const { frameA, frameB, width, height } = e.data;
 *   const t0 = performance.now();
 *
 *   // Lazily create offscreen canvases
 *   if (!canvasA || canvasA.width !== width || canvasA.height !== height) {
 *     canvasA = new OffscreenCanvas(width, height);
 *     canvasB = new OffscreenCanvas(width, height);
 *     ctxA = canvasA.getContext("2d", { willReadFrequently: true })!;
 *     ctxB = canvasB.getContext("2d", { willReadFrequently: true })!;
 *   }
 *
 *   // Draw VideoFrames to offscreen canvases (GPU-side downscale)
 *   // This is where the GPU->CPU readback cost occurs, but on the worker
 *   ctxA!.drawImage(frameA, 0, 0, width, height);
 *   ctxB!.drawImage(frameB, 0, 0, width, height);
 *
 *   // Close VideoFrames to release GPU resources
 *   frameA.close();
 *   frameB.close();
 *
 *   // Read pixel data (GPU->CPU readback)
 *   const dataA = ctxA!.getImageData(0, 0, width, height);
 *   const dataB = ctxB!.getImageData(0, 0, width, height);
 *
 *   // Compute PSNR
 *   let psnr: number | null = null;
 *   {
 *     const pA = dataA.data, pB = dataB.data;
 *     let sumSqDiff = 0, pixelCount = 0;
 *     for (let i = 0; i < pA.length; i += 4) {
 *       for (let c = 0; c < 3; c++) {
 *         const diff = (pA[i + c] - pB[i + c]) / 255;
 *         sumSqDiff += diff * diff;
 *       }
 *       pixelCount++;
 *     }
 *     const mse = sumSqDiff / (pixelCount * 3);
 *     psnr = mse < 1e-10 ? 60 : -10 * Math.log10(mse);
 *   }
 *
 *   // Compute SSIM
 *   const result = ssim(dataA, dataB, { ssim: "bezkrovny", downsample: false });
 *   const map = result.ssim_map;
 *   const mapBytes = new Uint8Array(map.data.length);
 *   for (let i = 0; i < map.data.length; i++) {
 *     mapBytes[i] = Math.round(Math.max(0, Math.min(1, map.data[i])) * 255);
 *   }
 *
 *   const computeTimeMs = performance.now() - t0;
 *
 *   // Transfer result back (mapBytes.buffer is transferred, not copied)
 *   self.postMessage(
 *     {
 *       type: "result",
 *       mapBytes,
 *       mapWidth: map.width,
 *       mapHeight: map.height,
 *       meanSsim: result.mssim,
 *       psnr,
 *       computeTimeMs,
 *     } satisfies SsimWorkerResponse,
 *     [mapBytes.buffer]
 *   );
 * };
 * ```
 */

// ---------------------------------------------------------------------------
// Performance Analysis
// ---------------------------------------------------------------------------

/**
 * ## Performance Comparison
 *
 * ### Current approach (main thread):
 * ```
 * Main thread cost per frame: 5-10ms
 *   drawImage(videoA, 160, 90)   }
 *   drawImage(videoB, 160, 90)   }  ~4-8ms (GPU->CPU readback, blocking)
 *   getImageData() x2            }
 *   SSIM compute                    ~0.2ms
 *   PSNR compute                    ~0.05ms
 *   quantize + texImage2D           ~0.05ms
 * ```
 *
 * ### Worker approach:
 * ```
 * Main thread cost per frame: ~0.1ms
 *   new VideoFrame(videoA)          ~0.05ms (GPU texture handle)
 *   new VideoFrame(videoB)          ~0.05ms
 *   postMessage([frame, frame])     ~0.01ms (transfer, not copy)
 *   receive result callback         ~0.01ms
 *   texImage2D(ssimMap)             ~0.02ms (small R8 texture)
 *
 * Worker thread cost per frame: 5-10ms (same total, but off main thread)
 *   drawImage(frame, 160, 90) x2   ~4-8ms (GPU->CPU readback)
 *   getImageData() x2               included above
 *   SSIM compute                    ~0.2ms
 *   PSNR compute                    ~0.05ms
 *   quantize                        ~0.02ms
 *   postMessage(result)             ~0.01ms
 * ```
 *
 * ### Key insight:
 * The worker approach does NOT reduce total compute time. It moves the
 * 5-10ms cost from the main thread to a background thread, eliminating
 * UI jank entirely. The main thread goes from 5-10ms to ~0.1ms per frame.
 *
 * This means the adaptive frame-skip in useDiffRenderer.ts becomes
 * unnecessary — the main thread can request metrics every frame, and the
 * worker will process them as fast as it can. If the worker falls behind,
 * the `pendingCompute` guard naturally drops frames.
 *
 * ### Caveats:
 * - VideoFrame must be close()'d promptly to avoid GPU memory leaks
 * - If the worker takes >33ms (1 frame at 30fps), results arrive late;
 *   the UI shows stale SSIM data. This is acceptable for a diagnostic overlay.
 * - drawImage(VideoFrame) in a worker's OffscreenCanvas may still trigger
 *   a synchronous GPU readback on some browsers. The benefit is architectural
 *   (off-main-thread) rather than raw performance.
 *
 * ## Recommendation
 *
 * This approach is worth implementing as Phase 5.1. It provides the single
 * largest UX improvement (eliminating main-thread jank) with moderate
 * implementation effort. It composes well with other optimizations:
 *
 * - Phase 2 (typed array SSIM): reduces worker-side compute time from
 *   0.2ms to <0.05ms, giving more budget for readback
 * - Phase 4 (WebGPU): eliminates readback entirely, reducing worker cost
 *   to <0.5ms total
 * - Vector 5.3 (resolution reduction): reduces readback cost by 4x if
 *   80x45 is acceptable
 */

// This file is documentation + type definitions only.
// The actual worker would be implemented in src/workers/ssimWorker.ts.
export {};

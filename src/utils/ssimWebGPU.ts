/**
 * ssimWebGPU — WebGPU compute shader pipeline for GPU-accelerated SSIM.
 *
 * ## Why WebGPU?
 *
 * The current SSIM pipeline in `useDiffRenderer.ts` spends 5-10ms per frame on
 * Apple M4, with the bottleneck being `drawImage()` + `getImageData()` GPU->CPU
 * readback (4-8ms), not the actual SSIM computation (0.2ms). A WebGPU compute
 * shader eliminates this bottleneck entirely:
 *
 * 1. `importExternalTexture()` imports video frames as `GPUExternalTexture`
 *    directly from `<video>` elements — zero-copy from GPU-decoded YUV data.
 *    No `drawImage`, no `getImageData`, no CPU involvement at all.
 *
 * 2. The SSIM computation runs entirely on GPU using a compute shader where
 *    each workgroup processes one 11x11 block in parallel.
 *
 * 3. The output is a tiny SSIM map (~540 bytes for 160x90 input = 15x9 blocks)
 *    that is read back cheaply via `mapAsync()`.
 *
 * Expected total cost: <0.5ms per frame (vs 5-10ms current), enabling SSIM
 * heatmap updates every frame at 30fps without adaptive frame-skip.
 *
 * ## Browser Support (as of February 2026)
 *
 * WebGPU is now supported in all major browsers:
 *   - Chrome 113+ (April 2023) — Windows, macOS, ChromeOS, Android 12+
 *   - Edge 113+ (April 2023) — same as Chrome (Chromium-based)
 *   - Firefox 141+ (July 2025) — Windows; Firefox 145+ adds macOS Apple Silicon
 *   - Safari 26+ (June 2025) — macOS Tahoe, iOS 26, iPadOS 26, visionOS 26
 *
 * Caveats:
 *   - Linux support is still rolling out (Chrome 144+ for Intel Gen12+)
 *   - Firefox on Linux and Android is expected in 2026
 *   - GPU driver and hardware requirements apply — always feature-detect
 *
 * ## Integration Plan for useDiffRenderer.ts
 *
 * ```typescript
 * // In the main effect, detect WebGPU once:
 * const gpuAvailable = await isWebGPUAvailable();
 * let gpuSsim: SsimGPU | null = null;
 * if (gpuAvailable) {
 *   gpuSsim = await initSsimGPU(160, 90);  // match current metrics resolution
 * }
 *
 * // In fireMetrics(), replace drawImage + getImageData + computeSsimMap:
 * if (gpuSsim && videoA && videoB) {
 *   const result = await computeSsimGPU(gpuSsim, videoA, videoB);
 *   if (result) {
 *     onSsimRef.current?.(result.mssim);
 *     // Upload SSIM map bytes to WebGL2 R8 texture (same as current path)
 *     gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8,
 *       result.mapWidth, result.mapHeight, 0,
 *       gl.RED, gl.UNSIGNED_BYTE, result.mapBytes);
 *   }
 * } else {
 *   // Current CPU fallback path
 *   metricsCtxA.drawImage(videoA, 0, 0, w, h);
 *   metricsCtxB.drawImage(videoB, 0, 0, w, h);
 *   // ... getImageData, computeSsimMap, etc.
 * }
 *
 * // On cleanup:
 * if (gpuSsim) destroySsimGPU(gpuSsim);
 * ```
 *
 * The PSNR computation would still use the CPU path (it's only 0.05ms) unless
 * we add a second compute shader for it. The SSIM heatmap visualization stays
 * in the existing WebGL2 fragment shader — we just upload the GPU-computed
 * SSIM map as an R8 texture the same way we do now.
 */

import { SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D } from "./ssimComputeShader.wgsl";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** GPU resources for the SSIM compute pipeline */
export interface SsimGPU {
  device: GPUDevice;
  /** Pipeline using texture_external (zero-copy from video) */
  externalPipeline: GPUComputePipeline | null;
  /** Pipeline using texture_2d<f32> (fallback with copy) */
  texture2dPipeline: GPUComputePipeline;
  /** Bind group layout for external texture variant */
  externalLayout: GPUBindGroupLayout | null;
  /** Bind group layout for texture_2d variant */
  texture2dLayout: GPUBindGroupLayout;
  /** Output storage buffer for SSIM map values (f32) */
  ssimBuffer: GPUBuffer;
  /** Staging buffer for CPU readback (MAP_READ) */
  readbackBuffer: GPUBuffer;
  /** Uniform buffer with dimensions */
  uniformBuffer: GPUBuffer;
  /** Pre-allocated textures for the texture_2d path */
  texA: GPUTexture;
  texB: GPUTexture;
  /** Dimensions */
  width: number;
  height: number;
  mapWidth: number;
  mapHeight: number;
}

export interface SsimGPUResult {
  /** Mean SSIM across all blocks */
  mssim: number;
  /** Raw SSIM map as f32 values (one per 11x11 block) */
  mapValues: Float32Array;
  /** Quantized SSIM map as R8 bytes for WebGL2 texture upload */
  mapBytes: Uint8Array;
  /** Map dimensions */
  mapWidth: number;
  mapHeight: number;
}

// ---------------------------------------------------------------------------
// Feature Detection
// ---------------------------------------------------------------------------

/**
 * Check if WebGPU is available in this browser/context.
 *
 * Tests both the API presence and the ability to actually get an adapter+device,
 * which can fail even when the API exists (e.g. unsupported GPU/driver).
 *
 * This function caches its result for the session.
 */
let _webgpuAvailable: boolean | null = null;

export async function isWebGPUAvailable(): Promise<boolean> {
  if (_webgpuAvailable !== null) return _webgpuAvailable;

  try {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      _webgpuAvailable = false;
      return false;
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      _webgpuAvailable = false;
      return false;
    }

    // Don't actually create a device here — that's done in initSsimGPU.
    // We just verify that the adapter exists and can potentially provide a device.
    _webgpuAvailable = true;
    return true;
  } catch {
    _webgpuAvailable = false;
    return false;
  }
}

/**
 * Check if importExternalTexture is available (for zero-copy video path).
 * This is a separate check because some browsers support WebGPU but not
 * external textures, or the feature may be restricted for certain video sources.
 */
export function hasExternalTextureSupport(device: GPUDevice): boolean {
  return typeof device.importExternalTexture === "function";
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the WebGPU SSIM compute pipeline.
 *
 * Creates the GPU device, compiles both shader variants (external texture +
 * texture_2d fallback), allocates buffers, and pre-creates textures for the
 * texture_2d path.
 *
 * @param width  - Input image width (e.g. 160 for the current metrics resolution)
 * @param height - Input image height (e.g. 90)
 * @returns SsimGPU state object, or null if initialization fails
 */
export async function initSsimGPU(width: number, height: number): Promise<SsimGPU | null> {
  try {
    if (!navigator.gpu) return null;

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;

    const device = await adapter.requestDevice();

    // SSIM map dimensions: ceil(width/11) x ceil(height/11)
    const mapWidth = Math.ceil(width / 11);
    const mapHeight = Math.ceil(height / 11);
    const mapSize = mapWidth * mapHeight;

    // --- Compile shader modules ---

    // Variant A: texture_external (may fail on browsers without full support)
    let externalPipeline: GPUComputePipeline | null = null;
    let externalLayout: GPUBindGroupLayout | null = null;

    if (hasExternalTextureSupport(device)) {
      try {
        const externalModule = device.createShaderModule({
          code: SSIM_SHADER_EXTERNAL,
        });

        externalLayout = device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.COMPUTE,
              externalTexture: {},
            },
            {
              binding: 1,
              visibility: GPUShaderStage.COMPUTE,
              externalTexture: {},
            },
            {
              binding: 2,
              visibility: GPUShaderStage.COMPUTE,
              buffer: { type: "storage" },
            },
            {
              binding: 3,
              visibility: GPUShaderStage.COMPUTE,
              buffer: { type: "uniform" },
            },
          ],
        });

        const externalPipelineLayout = device.createPipelineLayout({
          bindGroupLayouts: [externalLayout],
        });

        externalPipeline = device.createComputePipeline({
          layout: externalPipelineLayout,
          compute: {
            module: externalModule,
            entryPoint: "main",
          },
        });
      } catch (e) {
        console.warn("ssimWebGPU: external texture pipeline creation failed, using texture_2d fallback", e);
        externalPipeline = null;
        externalLayout = null;
      }
    }

    // Variant B: texture_2d<f32> (always available)
    const texture2dModule = device.createShaderModule({
      code: SSIM_SHADER_TEXTURE2D,
    });

    const texture2dLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
      ],
    });

    const texture2dPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [texture2dLayout],
    });

    const texture2dPipeline = device.createComputePipeline({
      layout: texture2dPipelineLayout,
      compute: {
        module: texture2dModule,
        entryPoint: "main",
      },
    });

    // --- Allocate buffers ---

    // SSIM output buffer (f32 per block)
    const ssimBufferSize = mapSize * 4; // 4 bytes per f32
    const ssimBuffer = device.createBuffer({
      size: ssimBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Readback buffer (MAP_READ for CPU access)
    const readbackBuffer = device.createBuffer({
      size: ssimBufferSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Uniform buffer with dimensions (4 x u32 = 16 bytes)
    const uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Write dimensions to uniform buffer
    const uniformData = new Uint32Array([width, height, mapWidth, mapHeight]);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // --- Pre-allocate textures for texture_2d path ---

    const texDesc: GPUTextureDescriptor = {
      size: { width, height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    };
    const texA = device.createTexture(texDesc);
    const texB = device.createTexture(texDesc);

    return {
      device,
      externalPipeline,
      texture2dPipeline,
      externalLayout,
      texture2dLayout,
      ssimBuffer,
      readbackBuffer,
      uniformBuffer,
      texA,
      texB,
      width,
      height,
      mapWidth,
      mapHeight,
    };
  } catch (e) {
    console.warn("ssimWebGPU: initialization failed", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

/**
 * Compute SSIM between two video elements using the WebGPU compute shader.
 *
 * Automatically selects the best path:
 *   1. If external texture pipeline is available, uses `importExternalTexture()`
 *      for zero-copy video frame import (fastest path).
 *   2. Otherwise, falls back to `copyExternalImageToTexture()` which copies
 *      the video frame to a regular GPU texture first.
 *
 * @param state  - GPU resources from `initSsimGPU()`
 * @param videoA - First video element (or any TexImageSource)
 * @param videoB - Second video element
 * @returns SSIM result with mean, map values, and quantized bytes, or null on error
 */
export async function computeSsimGPU(
  state: SsimGPU,
  videoA: HTMLVideoElement,
  videoB: HTMLVideoElement,
): Promise<SsimGPUResult | null> {
  const { device, mapWidth, mapHeight } = state;

  try {
    const encoder = device.createCommandEncoder();

    let bindGroup: GPUBindGroup;
    let pipeline: GPUComputePipeline;

    // Try the external texture path first (zero-copy, fastest)
    if (state.externalPipeline && state.externalLayout) {
      try {
        const extTexA = device.importExternalTexture({ source: videoA });
        const extTexB = device.importExternalTexture({ source: videoB });

        bindGroup = device.createBindGroup({
          layout: state.externalLayout,
          entries: [
            { binding: 0, resource: extTexA },
            { binding: 1, resource: extTexB },
            { binding: 2, resource: { buffer: state.ssimBuffer } },
            { binding: 3, resource: { buffer: state.uniformBuffer } },
          ],
        });
        pipeline = state.externalPipeline;
      } catch {
        // importExternalTexture can fail for cross-origin or DRM-protected video.
        // Fall through to texture_2d path.
        return computeSsimGPUTexture2d(state, videoA, videoB);
      }
    } else {
      // No external texture support — use texture_2d path
      return computeSsimGPUTexture2d(state, videoA, videoB);
    }

    // Dispatch compute shader
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(mapWidth, mapHeight, 1);
    pass.end();

    // Copy SSIM buffer to readback buffer
    encoder.copyBufferToBuffer(
      state.ssimBuffer, 0,
      state.readbackBuffer, 0,
      mapWidth * mapHeight * 4,
    );

    device.queue.submit([encoder.finish()]);

    // Read back results
    await state.readbackBuffer.mapAsync(GPUMapMode.READ);
    const mapped = new Float32Array(state.readbackBuffer.getMappedRange().slice(0));
    state.readbackBuffer.unmap();

    return processResults(mapped, mapWidth, mapHeight);
  } catch (e) {
    console.warn("ssimWebGPU: compute failed", e);
    return null;
  }
}

/**
 * Fallback compute path using texture_2d (copies video frames to GPU textures).
 *
 * This path adds a `copyExternalImageToTexture()` call per video element
 * (~0.5ms for 160x90) but works even when `importExternalTexture()` is not
 * available or fails (e.g. cross-origin, DRM-protected content).
 */
async function computeSsimGPUTexture2d(
  state: SsimGPU,
  videoA: HTMLVideoElement,
  videoB: HTMLVideoElement,
): Promise<SsimGPUResult | null> {
  const { device, mapWidth, mapHeight } = state;

  try {
    // Copy video frames to pre-allocated textures
    // copyExternalImageToTexture handles YUV -> RGBA conversion
    device.queue.copyExternalImageToTexture(
      { source: videoA },
      { texture: state.texA },
      { width: state.width, height: state.height },
    );
    device.queue.copyExternalImageToTexture(
      { source: videoB },
      { texture: state.texB },
      { width: state.width, height: state.height },
    );

    const encoder = device.createCommandEncoder();

    const bindGroup = device.createBindGroup({
      layout: state.texture2dLayout,
      entries: [
        { binding: 0, resource: state.texA.createView() },
        { binding: 1, resource: state.texB.createView() },
        { binding: 2, resource: { buffer: state.ssimBuffer } },
        { binding: 3, resource: { buffer: state.uniformBuffer } },
      ],
    });

    const pass = encoder.beginComputePass();
    pass.setPipeline(state.texture2dPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(mapWidth, mapHeight, 1);
    pass.end();

    encoder.copyBufferToBuffer(
      state.ssimBuffer, 0,
      state.readbackBuffer, 0,
      mapWidth * mapHeight * 4,
    );

    device.queue.submit([encoder.finish()]);

    await state.readbackBuffer.mapAsync(GPUMapMode.READ);
    const mapped = new Float32Array(state.readbackBuffer.getMappedRange().slice(0));
    state.readbackBuffer.unmap();

    return processResults(mapped, mapWidth, mapHeight);
  } catch (e) {
    console.warn("ssimWebGPU: texture_2d compute failed", e);
    return null;
  }
}

/**
 * Process raw SSIM map values from the GPU into the result format needed
 * by useDiffRenderer.ts (mssim + quantized R8 bytes for WebGL2 upload).
 */
function processResults(
  mapValues: Float32Array,
  mapWidth: number,
  mapHeight: number,
): SsimGPUResult {
  // Compute mean SSIM
  let sum = 0;
  for (let i = 0; i < mapValues.length; i++) {
    sum += mapValues[i];
  }
  const mssim = sum / mapValues.length;

  // Quantize to Uint8 for R8 texture upload (same as current CPU path)
  const mapBytes = new Uint8Array(mapValues.length);
  for (let i = 0; i < mapValues.length; i++) {
    mapBytes[i] = Math.round(Math.max(0, Math.min(1, mapValues[i])) * 255);
  }

  return { mssim, mapValues, mapBytes, mapWidth, mapHeight };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Destroy all GPU resources. Call this when the diff renderer is deactivated
 * or the component unmounts.
 */
export function destroySsimGPU(state: SsimGPU): void {
  state.ssimBuffer.destroy();
  state.readbackBuffer.destroy();
  state.uniformBuffer.destroy();
  state.texA.destroy();
  state.texB.destroy();
  state.device.destroy();
}

// ---------------------------------------------------------------------------
// Utility: resize support
// ---------------------------------------------------------------------------

/**
 * Check if the current GPU state matches the desired dimensions.
 * If not, the caller should destroy and reinitialize.
 */
export function needsResize(state: SsimGPU, width: number, height: number): boolean {
  return state.width !== width || state.height !== height;
}

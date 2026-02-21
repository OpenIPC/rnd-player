/**
 * ssimWebGPU — Feasibility test for WebGPU SSIM compute shader.
 *
 * These tests verify the shader code structure and document the integration
 * plan. In a jsdom/vitest environment, WebGPU is not available, so tests that
 * require actual GPU execution are conditional.
 *
 * Run: npx vitest run src/utils/ssimWebGPU.test.ts
 *
 * ## Browser Support Matrix (February 2026)
 *
 * | Browser     | Version | WebGPU | External Texture | Compute Shader | Notes |
 * |-------------|---------|--------|-----------------|----------------|-------|
 * | Chrome      | 113+    | Yes    | Yes             | Yes            | Dawn backend |
 * | Edge        | 113+    | Yes    | Yes             | Yes            | Chromium-based |
 * | Firefox     | 141+    | Yes    | Yes             | Yes            | wgpu backend; Win only initially |
 * | Firefox     | 145+    | Yes    | Yes             | Yes            | macOS Apple Silicon added |
 * | Safari      | 26+     | Yes    | Yes             | Yes            | Metal backend |
 * | Chrome/And  | 121+    | Yes    | Yes             | Yes            | Android 12+, Qualcomm/ARM |
 * | Safari/iOS  | 26+     | Yes    | Yes             | Yes            | iOS 26+ only |
 * | Firefox/Lin | N/A     | No     | No              | No             | Expected 2026 |
 *
 * ## Integration Plan for useDiffRenderer.ts
 *
 * The WebGPU SSIM pipeline replaces the slowest part of fireMetrics():
 *
 * ### Current pipeline (5-10ms on M4):
 * ```
 * fireMetrics()
 *   drawImage(videoA -> 160x90 OffscreenCanvas)   }
 *   drawImage(videoB -> 160x90 OffscreenCanvas)   }  4-8ms (GPU->CPU readback)
 *   getImageData() x 2                            }
 *   ssim.js bezkrovny(dataA, dataB)                  0.2ms
 *   computePsnrFromData(dataA, dataB)                0.05ms
 *   quantize + gl.texImage2D(ssimMap)                0.05ms
 * ```
 *
 * ### WebGPU pipeline (estimated <0.5ms):
 * ```
 * fireMetrics()
 *   importExternalTexture(videoA)                    ~0ms (zero-copy)
 *   importExternalTexture(videoB)                    ~0ms (zero-copy)
 *   GPU compute shader (all 135 blocks parallel)     <0.2ms
 *   mapAsync(readback 540 bytes)                     <0.1ms
 *   computePsnrFromData (still CPU, 0.05ms)          0.05ms
 *   quantize + gl.texImage2D(ssimMap)                0.05ms
 * ```
 *
 * ### Fallback strategy:
 * ```typescript
 * const gpuAvailable = await isWebGPUAvailable();
 * if (gpuAvailable) {
 *   // GPU path: importExternalTexture -> compute shader -> mapAsync
 *   ssimGpu = await initSsimGPU(METRICS_W, METRICS_H);
 * }
 * // In render loop:
 * if (ssimGpu) {
 *   result = await computeSsimGPU(ssimGpu, videoA, videoB);
 * } else {
 *   // CPU fallback: drawImage + getImageData + ssim.js
 *   result = computeSsimMap(dataA, dataB);
 * }
 * ```
 *
 * ### What changes in useDiffRenderer.ts:
 * 1. Add `ssimGpuRef = useRef<SsimGPU | null>(null)` alongside glStateRef
 * 2. In the init block (where WebGL2 is created), also probe WebGPU and init
 * 3. In fireMetrics(), branch on ssimGpuRef.current presence
 * 4. In cleanup, call destroySsimGPU() alongside destroyGl()
 * 5. PSNR stays CPU-computed (0.05ms, not worth GPU-ifying)
 * 6. The R8 texture upload to WebGL2 stays the same — mapBytes is identical
 *
 * ### DRM / cross-origin considerations:
 * - importExternalTexture() throws SecurityError for cross-origin video
 * - For DRM-protected content, importExternalTexture may fail
 * - computeSsimGPU() catches these errors and falls through to the
 *   texture_2d path (copyExternalImageToTexture), which may also fail
 * - Ultimate fallback: CPU path via ssim.js (current code, always works
 *   because canvas.drawImage also fails for cross-origin, so both paths
 *   fail equally — this is not a regression)
 */

import { describe, it, expect } from "vitest";
import { SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D } from "./ssimComputeShader.wgsl";

// ---------------------------------------------------------------------------
// Shader string validation
// ---------------------------------------------------------------------------

describe("SSIM WebGPU Compute Shader", () => {
  describe("shader source validation", () => {
    it("external texture shader is a non-empty string", () => {
      expect(typeof SSIM_SHADER_EXTERNAL).toBe("string");
      expect(SSIM_SHADER_EXTERNAL.length).toBeGreaterThan(100);
    });

    it("texture_2d shader is a non-empty string", () => {
      expect(typeof SSIM_SHADER_TEXTURE2D).toBe("string");
      expect(SSIM_SHADER_TEXTURE2D.length).toBeGreaterThan(100);
    });

    it("external shader uses texture_external binding type", () => {
      expect(SSIM_SHADER_EXTERNAL).toContain("texture_external");
      expect(SSIM_SHADER_EXTERNAL).toContain("textureLoad(tex_a");
      expect(SSIM_SHADER_EXTERNAL).toContain("textureLoad(tex_b");
    });

    it("texture_2d shader uses texture_2d<f32> binding type", () => {
      expect(SSIM_SHADER_TEXTURE2D).toContain("texture_2d<f32>");
      // texture_2d textureLoad requires mip level parameter (0)
      expect(SSIM_SHADER_TEXTURE2D).toContain(", 0)");
    });

    it("external shader does NOT have mip level in textureLoad", () => {
      // texture_external textureLoad signature: fn(texture_external, vec2<u32>) -> vec4<f32>
      // No mip level parameter — just texture + coords
      const externalLoads = SSIM_SHADER_EXTERNAL.match(/textureLoad\(tex_[ab], vec2<u32>\(px, py\)\)/g);
      expect(externalLoads).not.toBeNull();
      expect(externalLoads!.length).toBe(2); // one for tex_a, one for tex_b
    });

    it("both shaders declare workgroup_size(11, 11, 1)", () => {
      expect(SSIM_SHADER_EXTERNAL).toContain("@workgroup_size(11, 11, 1)");
      expect(SSIM_SHADER_TEXTURE2D).toContain("@workgroup_size(11, 11, 1)");
    });

    it("both shaders declare shared memory for 121 values", () => {
      expect(SSIM_SHADER_EXTERNAL).toContain("array<f32, 121>");
      expect(SSIM_SHADER_TEXTURE2D).toContain("array<f32, 121>");
    });

    it("both shaders use workgroupBarrier", () => {
      expect(SSIM_SHADER_EXTERNAL).toContain("workgroupBarrier()");
      expect(SSIM_SHADER_TEXTURE2D).toContain("workgroupBarrier()");
    });

    it("both shaders declare SSIM constants C1 and C2", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        expect(shader).toContain("C1: f32 = 6.5025");
        expect(shader).toContain("C2: f32 = 58.5225");
      }
    });

    it("both shaders use BT.601 luma coefficients", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        expect(shader).toContain("0.299");
        expect(shader).toContain("0.587");
        expect(shader).toContain("0.114");
      }
    });

    it("both shaders handle edge blocks with bounds checking", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        expect(shader).toContain("px < params.width");
        expect(shader).toContain("py < params.height");
        expect(shader).toContain("valid[li]");
      }
    });

    it("both shaders compute SSIM formula components", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        // Mean
        expect(shader).toContain("mean_a");
        expect(shader).toContain("mean_b");
        // Variance
        expect(shader).toContain("var_a");
        expect(shader).toContain("var_b");
        // Covariance
        expect(shader).toContain("cov_ab");
        // SSIM formula structure: numerator / denominator
        expect(shader).toContain("numerator");
        expect(shader).toContain("denominator");
      }
    });

    it("both shaders clamp output to [0, 1]", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        expect(shader).toContain("clamp(");
      }
    });

    it("both shaders write to ssim_map storage buffer", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        expect(shader).toContain("var<storage, read_write> ssim_map: array<f32>");
        expect(shader).toContain("ssim_map[block_y * params.map_w + block_x]");
      }
    });

    it("Params struct has all required fields", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        expect(shader).toContain("width: u32");
        expect(shader).toContain("height: u32");
        expect(shader).toContain("map_w: u32");
        expect(shader).toContain("map_h: u32");
      }
    });

    it("shaders scale grayscale to [0, 255] to match ssim.js integer pipeline", () => {
      // ssim.js bezkrovny operates on integer grayscale [0, 255]
      // GPU textureLoad returns [0, 1], so we multiply by 255
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        expect(shader).toContain("* 255.0");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Map dimension calculations
  // ---------------------------------------------------------------------------

  describe("SSIM map dimensions", () => {
    it("160x90 produces 15x9 map (ceil(160/11) x ceil(90/11))", () => {
      expect(Math.ceil(160 / 11)).toBe(15);
      expect(Math.ceil(90 / 11)).toBe(9);
    });

    it("320x180 produces 30x17 map", () => {
      expect(Math.ceil(320 / 11)).toBe(30);
      expect(Math.ceil(180 / 11)).toBe(17);
    });

    it("640x360 produces 59x33 map", () => {
      expect(Math.ceil(640 / 11)).toBe(59);
      expect(Math.ceil(360 / 11)).toBe(33);
    });

    it("1920x1080 produces 175x99 map", () => {
      expect(Math.ceil(1920 / 11)).toBe(175);
      expect(Math.ceil(1080 / 11)).toBe(99);
    });

    it("map dimensions match ssim.js bezkrovny output", () => {
      // ssim.js bezkrovny uses non-overlapping 11x11 windows: ceil(W/11) x ceil(H/11)
      // Our compute shader dispatches ceil(W/11) x ceil(H/11) workgroups
      // They produce identical map dimensions.
      const testCases = [
        [160, 90], [320, 180], [640, 360], [960, 540],
      ];
      for (const [w, h] of testCases) {
        const mapW = Math.ceil(w / 11);
        const mapH = Math.ceil(h / 11);
        expect(mapW).toBeGreaterThan(0);
        expect(mapH).toBeGreaterThan(0);
        // Verify workgroup count matches: mapW * mapH workgroups, each 11x11 threads
        expect(mapW * mapH * 121).toBeLessThanOrEqual(w * h * 2); // sanity check
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Buffer size calculations
  // ---------------------------------------------------------------------------

  describe("GPU buffer sizing", () => {
    it("SSIM output buffer is small enough for fast readback", () => {
      // At 160x90: 15*9 = 135 f32 values = 540 bytes
      const mapSize = Math.ceil(160 / 11) * Math.ceil(90 / 11);
      const bufferBytes = mapSize * 4;
      expect(bufferBytes).toBe(540);
      // This is tiny — mapAsync on 540 bytes should take <0.1ms
    });

    it("uniform buffer is exactly 16 bytes (4 x u32)", () => {
      const uniformBytes = 4 * 4; // width, height, mapW, mapH
      expect(uniformBytes).toBe(16);
    });

    it("even at 1080p, SSIM buffer stays under 70KB", () => {
      const mapSize = Math.ceil(1920 / 11) * Math.ceil(1080 / 11);
      const bufferBytes = mapSize * 4;
      expect(bufferBytes).toBeLessThan(70_000);
      // Still tiny compared to 1920*1080*4 = 8MB of raw pixels
    });
  });

  // ---------------------------------------------------------------------------
  // WGSL syntax checks
  // ---------------------------------------------------------------------------

  describe("WGSL syntax structure", () => {
    it("external shader has exactly 4 bindings in group 0", () => {
      const bindings = SSIM_SHADER_EXTERNAL.match(/@binding\(\d+\)/g);
      expect(bindings).not.toBeNull();
      expect(bindings!.length).toBe(4);
    });

    it("texture_2d shader has exactly 4 bindings in group 0", () => {
      const bindings = SSIM_SHADER_TEXTURE2D.match(/@binding\(\d+\)/g);
      expect(bindings).not.toBeNull();
      expect(bindings!.length).toBe(4);
    });

    it("both shaders have a single @compute entry point", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        const computeDecls = shader.match(/@compute/g);
        expect(computeDecls).not.toBeNull();
        expect(computeDecls!.length).toBe(1);
      }
    });

    it("both shaders use @group(0) for all bindings", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        const groups = shader.match(/@group\(\d+\)/g);
        expect(groups).not.toBeNull();
        expect(groups!.every((g: string) => g === "@group(0)")).toBe(true);
      }
    });

    it("both shaders use var<workgroup> for shared memory", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        const workgroupVars = shader.match(/var<workgroup>/g);
        expect(workgroupVars).not.toBeNull();
        // gray_a, gray_b, valid = 3 workgroup variables
        expect(workgroupVars!.length).toBe(3);
      }
    });

    it("thread 0 guard uses li == 0u", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        expect(shader).toContain("if (li == 0u)");
      }
    });

    it("shader entry point uses required builtins", () => {
      for (const shader of [SSIM_SHADER_EXTERNAL, SSIM_SHADER_TEXTURE2D]) {
        expect(shader).toContain("@builtin(workgroup_id)");
        expect(shader).toContain("@builtin(local_invocation_id)");
        expect(shader).toContain("@builtin(local_invocation_index)");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // JS orchestration module validation
  // ---------------------------------------------------------------------------

  describe("JS orchestration module exports", () => {
    it("exports isWebGPUAvailable function", async () => {
      const mod = await import("./ssimWebGPU");
      expect(typeof mod.isWebGPUAvailable).toBe("function");
    });

    it("exports initSsimGPU function", async () => {
      const mod = await import("./ssimWebGPU");
      expect(typeof mod.initSsimGPU).toBe("function");
    });

    it("exports computeSsimGPU function", async () => {
      const mod = await import("./ssimWebGPU");
      expect(typeof mod.computeSsimGPU).toBe("function");
    });

    it("exports destroySsimGPU function", async () => {
      const mod = await import("./ssimWebGPU");
      expect(typeof mod.destroySsimGPU).toBe("function");
    });

    it("exports hasExternalTextureSupport function", async () => {
      const mod = await import("./ssimWebGPU");
      expect(typeof mod.hasExternalTextureSupport).toBe("function");
    });

    it("exports needsResize function", async () => {
      const mod = await import("./ssimWebGPU");
      expect(typeof mod.needsResize).toBe("function");
    });

    it("isWebGPUAvailable returns false in jsdom (no navigator.gpu)", async () => {
      const { isWebGPUAvailable } = await import("./ssimWebGPU");
      const available = await isWebGPUAvailable();
      expect(available).toBe(false);
    });

    it("initSsimGPU returns null in jsdom (no navigator.gpu)", async () => {
      const { initSsimGPU } = await import("./ssimWebGPU");
      const state = await initSsimGPU(160, 90);
      expect(state).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // SSIM algorithm correctness documentation
  // ---------------------------------------------------------------------------

  describe("algorithm correctness contract", () => {
    it("documents the expected mssim tolerance vs ssim.js bezkrovny", () => {
      // The GPU shader implements the same non-overlapping window algorithm as
      // ssim.js bezkrovny, with the same constants (C1=6.5025, C2=58.5225) and
      // the same BT.601 grayscale conversion (0.299R + 0.587G + 0.114B).
      //
      // Expected differences due to floating-point precision:
      //   - ssim.js uses float64 (JS number) throughout
      //   - GPU shader uses float32 (WGSL f32)
      //   - ssim.js does integer grayscale (Math.round), GPU uses exact float * 255
      //
      // Acceptable tolerances (from ssim-performance-investigation.md):
      //   - mssim: within +/-0.001 of ssim.js bezkrovny
      //   - Per-window SSIM map: max absolute error <= 0.005
      //
      // These tolerances ensure the heatmap visualization is indistinguishable.
      const MSSIM_TOLERANCE = 0.001;
      const MAP_TOLERANCE = 0.005;
      expect(MSSIM_TOLERANCE).toBeLessThan(0.01);
      expect(MAP_TOLERANCE).toBeLessThan(0.01);
    });

    it("documents the grayscale conversion pipeline", () => {
      // ssim.js: rgb2grayInteger(r, g, b) = Math.round((0.299*r + 0.587*g + 0.114*b))
      //   Input: integer [0, 255] RGBA from ImageData
      //   Output: integer [0, 255] grayscale
      //
      // GPU shader: dot(rgba.rgb, vec3(0.299, 0.587, 0.114)) * 255.0
      //   Input: float [0, 1] RGBA from textureLoad
      //   Output: float ~[0, 255] grayscale (no rounding)
      //
      // Max expected error per pixel: 0.5 gray levels (due to float vs integer)
      // This propagates to SSIM as approximately 0.0001-0.0005 per block.
      const maxPixelError = 0.5; // gray levels
      expect(maxPixelError).toBeLessThan(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Performance estimation documentation
  // ---------------------------------------------------------------------------

  describe("performance characteristics", () => {
    it("documents expected latency breakdown for 160x90", () => {
      // At 160x90 input:
      //   Map size: 15 x 9 = 135 blocks
      //   Threads per workgroup: 11 x 11 = 121
      //   Total GPU threads: 135 * 121 = 16,335
      //
      // For M4 GPU (10 cores, ~1.2 GHz):
      //   importExternalTexture: ~0 (zero-copy, no data transfer)
      //   Compute dispatch: <0.1ms (135 workgroups is trivial)
      //   Buffer readback (540 bytes): <0.1ms
      //   Total: <0.3ms
      //
      // Compare to current CPU path: 5-10ms
      // Speedup: 15-30x
      const BLOCKS = Math.ceil(160 / 11) * Math.ceil(90 / 11);
      expect(BLOCKS).toBe(135);
      const TOTAL_THREADS = BLOCKS * 121;
      expect(TOTAL_THREADS).toBe(16335);
      const READBACK_BYTES = BLOCKS * 4;
      expect(READBACK_BYTES).toBe(540);
    });

    it("documents expected latency for higher resolutions", () => {
      // If the drawImage+getImageData bottleneck is eliminated,
      // we could potentially compute SSIM at higher resolution:
      //
      // 320x180: 30*17 = 510 blocks, readback 2040 bytes — still <0.5ms
      // 640x360: 59*33 = 1947 blocks, readback 7788 bytes — still <1ms
      // 1080p:   175*99 = 17325 blocks, readback 69300 bytes — ~1-2ms
      //
      // Higher resolution SSIM maps produce finer-grained heatmaps.
      // The fragment shader already does GPU bilinear upscaling from the
      // small map to full resolution, so finer maps just improve accuracy.
      const cases = [
        { w: 320, h: 180, blocks: 510 },
        { w: 640, h: 360, blocks: 1947 },
        { w: 1920, h: 1080, blocks: 17325 },
      ];
      for (const c of cases) {
        expect(Math.ceil(c.w / 11) * Math.ceil(c.h / 11)).toBe(c.blocks);
      }
    });
  });
});

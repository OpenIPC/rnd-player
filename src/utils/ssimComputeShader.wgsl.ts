/**
 * SSIM Compute Shader — WGSL source for WebGPU-based SSIM computation.
 *
 * Computes per-block SSIM values using the bezkrovny non-overlapping window
 * approach (11x11 blocks) entirely on the GPU. Each workgroup processes one
 * block using parallel reduction in shared memory.
 *
 * Two shader variants are provided:
 *
 * **Variant A (`SSIM_SHADER_EXTERNAL`)**: Uses `texture_external` bindings.
 *   - Video frames imported via `device.importExternalTexture()` from `<video>`
 *     elements. Zero-copy from GPU-decoded YUV — no `drawImage`, no `getImageData`.
 *   - Uses `textureLoad(texture_external, vec2<u32>)` which is supported per the
 *     WGSL spec (section 17.7.4). Returns `vec4<f32>` with no mip level parameter.
 *   - External textures expire at the end of the current microtask, so the bind
 *     group must be recreated each frame.
 *   - Browser support: Chrome 113+, Edge 113+, Firefox 141+, Safari 26+
 *     (wherever WebGPU is available).
 *
 * **Variant B (`SSIM_SHADER_TEXTURE2D`)**: Uses `texture_2d<f32>` bindings.
 *   - Accepts regular GPU textures uploaded via `copyExternalImageToTexture()`.
 *   - More broadly compatible but requires a copy of the video frame into a
 *     regular texture first (adds ~1ms for 1080p).
 *   - Useful as a fallback when `importExternalTexture` is not available, or
 *     when working with non-video sources (e.g. ImageBitmap, OffscreenCanvas).
 *
 * Both variants share the same compute logic:
 *   1. Each workgroup = one 11x11 SSIM block (workgroup_size = 11x11x1 = 121 threads)
 *   2. Each thread loads one pixel, converts RGB to grayscale (BT.601 luma)
 *   3. Shared memory stores grayscale values for parallel reduction
 *   4. Thread 0 computes mean, variance, covariance, and final SSIM
 *   5. Edge blocks (image border) are handled by clamping to image dimensions
 *   6. Output: one f32 SSIM value per block written to a storage buffer
 *
 * Integration with useDiffRenderer.ts:
 *   - Replace `drawImage()` + `getImageData()` readback with `importExternalTexture()`
 *   - Replace `computeSsimMap()` with `computeSsimGPU()`
 *   - The output SSIM map (f32 storage buffer, ~540 bytes for 15x9) can be:
 *     (a) Read back to CPU via `mapAsync` for mssim calculation + history tracking
 *     (b) Bound directly as a storage buffer in the existing WebGL2 fragment shader
 *         (would require porting the visualization shader to WebGPU too)
 *   - Fallback: detect WebGPU -> GPU path; no WebGPU -> current CPU path
 */

// ---------------------------------------------------------------------------
// Variant A: texture_external (zero-copy from <video>)
// ---------------------------------------------------------------------------

export const SSIM_SHADER_EXTERNAL = /* wgsl */ `
// Uniforms: image dimensions and SSIM map dimensions
struct Params {
  width: u32,
  height: u32,
  map_w: u32,
  map_h: u32,
}

@group(0) @binding(0) var tex_a: texture_external;
@group(0) @binding(1) var tex_b: texture_external;
@group(0) @binding(2) var<storage, read_write> ssim_map: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

// SSIM constants for 8-bit images (L=255)
// C1 = (k1*L)^2 = (0.01*255)^2 = 6.5025
// C2 = (k2*L)^2 = (0.03*255)^2 = 58.5225
const C1: f32 = 6.5025;
const C2: f32 = 58.5225;
const WINDOW: u32 = 11u;

// BT.601 luma coefficients for RGB -> grayscale
const LUMA: vec3<f32> = vec3<f32>(0.299, 0.587, 0.114);

// Shared memory for the 11x11 block (121 values per image)
var<workgroup> gray_a: array<f32, 121>;
var<workgroup> gray_b: array<f32, 121>;
// Flags for valid pixels (1.0 = inside image, 0.0 = outside / edge padding)
var<workgroup> valid: array<f32, 121>;

@compute @workgroup_size(11, 11, 1)
fn main(
  @builtin(workgroup_id) wg_id: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
) {
  let block_x = wg_id.x;
  let block_y = wg_id.y;

  // Pixel coordinates in the source image
  let px = block_x * WINDOW + lid.x;
  let py = block_y * WINDOW + lid.y;

  // Handle edge blocks: pixels outside image bounds contribute 0
  let in_bounds = px < params.width && py < params.height;

  if (in_bounds) {
    // textureLoad on texture_external: returns vec4<f32> with RGB in [0,1]
    let rgba_a = textureLoad(tex_a, vec2<u32>(px, py));
    let rgba_b = textureLoad(tex_b, vec2<u32>(px, py));

    // Convert to grayscale luminance [0, 255] to match ssim.js integer pipeline
    gray_a[li] = dot(rgba_a.rgb, LUMA) * 255.0;
    gray_b[li] = dot(rgba_b.rgb, LUMA) * 255.0;
    valid[li] = 1.0;
  } else {
    gray_a[li] = 0.0;
    gray_b[li] = 0.0;
    valid[li] = 0.0;
  }

  // Synchronize so all threads have loaded their pixels
  workgroupBarrier();

  // Thread 0 computes the SSIM value for this block
  if (li == 0u) {
    var sum_a: f32 = 0.0;
    var sum_b: f32 = 0.0;
    var sum_sq_a: f32 = 0.0;
    var sum_sq_b: f32 = 0.0;
    var sum_cross: f32 = 0.0;
    var count: f32 = 0.0;

    // Accumulate over all valid pixels in this block
    for (var i = 0u; i < 121u; i = i + 1u) {
      let v = valid[i];
      let a = gray_a[i];
      let b = gray_b[i];
      sum_a = sum_a + a * v;
      sum_b = sum_b + b * v;
      sum_sq_a = sum_sq_a + a * a * v;
      sum_sq_b = sum_sq_b + b * b * v;
      sum_cross = sum_cross + a * b * v;
      count = count + v;
    }

    // Avoid division by zero for completely out-of-bounds blocks
    // (shouldn't happen if dispatch dimensions are correct, but be safe)
    if (count < 1.0) {
      ssim_map[block_y * params.map_w + block_x] = 1.0;
      return;
    }

    let mean_a = sum_a / count;
    let mean_b = sum_b / count;

    // Variance: E[X^2] - E[X]^2
    let var_a = sum_sq_a / count - mean_a * mean_a;
    let var_b = sum_sq_b / count - mean_b * mean_b;

    // Covariance: E[XY] - E[X]*E[Y]
    let cov_ab = sum_cross / count - mean_a * mean_b;

    // SSIM formula (Wang et al. 2004)
    let numerator = (2.0 * mean_a * mean_b + C1) * (2.0 * cov_ab + C2);
    let denominator = (mean_a * mean_a + mean_b * mean_b + C1) * (var_a + var_b + C2);

    let ssim_val = numerator / denominator;

    // Write to output map (clamped to [0, 1] for safety)
    ssim_map[block_y * params.map_w + block_x] = clamp(ssim_val, 0.0, 1.0);
  }
}
`;

// ---------------------------------------------------------------------------
// Variant B: texture_2d<f32> (regular textures, broader compatibility)
// ---------------------------------------------------------------------------

export const SSIM_SHADER_TEXTURE2D = /* wgsl */ `
// Uniforms: image dimensions and SSIM map dimensions
struct Params {
  width: u32,
  height: u32,
  map_w: u32,
  map_h: u32,
}

@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> ssim_map: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

// SSIM constants for 8-bit images (L=255)
const C1: f32 = 6.5025;
const C2: f32 = 58.5225;
const WINDOW: u32 = 11u;

const LUMA: vec3<f32> = vec3<f32>(0.299, 0.587, 0.114);

var<workgroup> gray_a: array<f32, 121>;
var<workgroup> gray_b: array<f32, 121>;
var<workgroup> valid: array<f32, 121>;

@compute @workgroup_size(11, 11, 1)
fn main(
  @builtin(workgroup_id) wg_id: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
) {
  let block_x = wg_id.x;
  let block_y = wg_id.y;

  let px = block_x * WINDOW + lid.x;
  let py = block_y * WINDOW + lid.y;

  let in_bounds = px < params.width && py < params.height;

  if (in_bounds) {
    // textureLoad on texture_2d: requires mip level (0)
    let rgba_a = textureLoad(tex_a, vec2<u32>(px, py), 0);
    let rgba_b = textureLoad(tex_b, vec2<u32>(px, py), 0);

    gray_a[li] = dot(rgba_a.rgb, LUMA) * 255.0;
    gray_b[li] = dot(rgba_b.rgb, LUMA) * 255.0;
    valid[li] = 1.0;
  } else {
    gray_a[li] = 0.0;
    gray_b[li] = 0.0;
    valid[li] = 0.0;
  }

  workgroupBarrier();

  if (li == 0u) {
    var sum_a: f32 = 0.0;
    var sum_b: f32 = 0.0;
    var sum_sq_a: f32 = 0.0;
    var sum_sq_b: f32 = 0.0;
    var sum_cross: f32 = 0.0;
    var count: f32 = 0.0;

    for (var i = 0u; i < 121u; i = i + 1u) {
      let v = valid[i];
      let a = gray_a[i];
      let b = gray_b[i];
      sum_a = sum_a + a * v;
      sum_b = sum_b + b * v;
      sum_sq_a = sum_sq_a + a * a * v;
      sum_sq_b = sum_sq_b + b * b * v;
      sum_cross = sum_cross + a * b * v;
      count = count + v;
    }

    if (count < 1.0) {
      ssim_map[block_y * params.map_w + block_x] = 1.0;
      return;
    }

    let mean_a = sum_a / count;
    let mean_b = sum_b / count;
    let var_a = sum_sq_a / count - mean_a * mean_a;
    let var_b = sum_sq_b / count - mean_b * mean_b;
    let cov_ab = sum_cross / count - mean_a * mean_b;

    let numerator = (2.0 * mean_a * mean_b + C1) * (2.0 * cov_ab + C2);
    let denominator = (mean_a * mean_a + mean_b * mean_b + C1) * (var_a + var_b + C2);

    ssim_map[block_y * params.map_w + block_x] = clamp(numerator / denominator, 0.0, 1.0);
  }
}
`;

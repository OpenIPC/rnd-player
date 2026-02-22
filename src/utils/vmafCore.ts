/**
 * vmafCore — Pure TypeScript implementation of VMAF v0.6.1.
 *
 * Implements the three elementary features (VIF, ADM2, Motion2) and the
 * SVM prediction pipeline. Designed for real-time use at reduced resolution
 * (120×68 or similar) in the browser.
 *
 * Reference: Netflix libvmaf integer_vif.c, integer_adm.c, integer_motion.c
 * Model: vmaf_v0.6.1.json (nu-SVR with RBF kernel, 211 support vectors)
 *
 * Run tests: npx vitest run src/utils/vmafCore.test.ts
 */

import {
  VMAF_GAMMA,
  VMAF_RHO,
  SCORE_SLOPE,
  SCORE_INTERCEPT,
  FEATURE_SLOPES,
  FEATURE_INTERCEPTS,
  TRANSFORM_P0,
  TRANSFORM_P1,
  TRANSFORM_P2,
  SUPPORT_VECTORS,
  VMAF_4K_RHO,
  VMAF_4K_SCORE_SLOPE,
  VMAF_4K_SCORE_INTERCEPT,
  VMAF_4K_FEATURE_SLOPES,
  VMAF_4K_FEATURE_INTERCEPTS,
  VMAF_4K_SUPPORT_VECTORS,
} from "./vmafModel";

// ============================================================================
// Types
// ============================================================================

export type VmafModelId = "hd" | "phone" | "4k" | "neg";

export interface VmafFeatures {
  vif_scale0: number;
  vif_scale1: number;
  vif_scale2: number;
  vif_scale3: number;
  adm2: number;
  motion2: number;
}

export interface VmafResult {
  /** VMAF score 0-100 */
  score: number;
  /** Raw feature values before normalization */
  features: VmafFeatures;
}

export interface VmafState {
  /** Previous frame blurred grayscale for motion computation */
  prevBlurred: Float64Array | null;
  /** Previous motion score for motion2 (min of two consecutive) */
  prevMotion: number;
}

// ============================================================================
// Constants
// ============================================================================

// VIF filter kernels (integer coefficients, sum = 65536)
const VIF_FILTER_0 = new Float64Array([489, 935, 1640, 2640, 3896, 5274, 6547, 7455, 7784, 7455, 6547, 5274, 3896, 2640, 1640, 935, 489]);
const VIF_FILTER_1 = new Float64Array([1244, 3663, 7925, 12590, 14692, 12590, 7925, 3663, 1244]);
const VIF_FILTER_2 = new Float64Array([3571, 16004, 26386, 16004, 3571]);
const VIF_FILTER_3 = new Float64Array([10904, 43728, 10904]);
const VIF_FILTERS = [VIF_FILTER_0, VIF_FILTER_1, VIF_FILTER_2, VIF_FILTER_3];
const FILTER_SUM = 65536;

// VIF noise variance (sigma_nsq). In the integer code this is 65536 << 1 = 131072
// in Q16 fixed-point. In floating-point at [0,255] range this is 2.0.
const VIF_SIGMA_NSQ = 2.0;

// VIF enhancement gain limit (default; NEG model uses 1.0)
const VIF_ENHN_GAIN_LIMIT_DEFAULT = 100.0;

// ADM Daubechies-2 wavelet filter coefficients (floating-point)
const DWT_LO = new Float64Array([0.48296291314469025, 0.83651630373746899, 0.22414386804185735, -0.12940952255092145]);
const DWT_HI = new Float64Array([-0.12940952255092145, -0.22414386804185735, 0.83651630373746899, -0.48296291314469025]);

// ADM CSF parameters for Y channel
const ADM_CSF_A = 0.495;
const ADM_CSF_K = 0.466;
const ADM_CSF_F0 = 0.401;
const ADM_CSF_G = [1.501, 1.0, 0.534, 1.0]; // h, v, d, a
const ADM_NORM_VIEW_DIST = 3.0;
const ADM_REF_DISPLAY_HEIGHT = 1080;
const ADM_BORDER_FACTOR = 0.1;
const ADM_ENHN_GAIN_LIMIT_DEFAULT = 100.0;

// ADM basis function amplitudes per scale (1-indexed in libvmaf, 0-indexed here)
// [h, v, d, a] for each scale
const ADM_BASIS_AMP: readonly (readonly number[])[] = [
  [0.62171, 0.67234, 0.72709, 0.67234],
  [0.34537, 0.41317, 0.49428, 0.41317],
  [0.18004, 0.22727, 0.28688, 0.22727],
  [0.091401, 0.11792, 0.15214, 0.11792],
];

// Motion blur filter (same as VIF Scale 2)
const MOTION_FILTER = VIF_FILTER_2;

// ============================================================================
// Utility: grayscale conversion
// ============================================================================

/** Convert RGBA ImageData to Float64Array grayscale [0,255] using BT.601 */
export function rgbaToGray(rgba: Uint8ClampedArray, width: number, height: number): Float64Array {
  const gray = new Float64Array(width * height);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    gray[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return gray;
}

// ============================================================================
// Utility: separable convolution with mirror padding
// ============================================================================

/**
 * Apply 1D separable convolution (horizontal or vertical) with mirror padding.
 * The kernel is normalized by dividing by `kernelSum`.
 */
function convolve1D(
  input: Float64Array, width: number, height: number,
  kernel: Float64Array, horizontal: boolean,
): Float64Array {
  const output = new Float64Array(width * height);
  const kLen = kernel.length;
  const kHalf = (kLen - 1) >> 1;

  if (horizontal) {
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let k = 0; k < kLen; k++) {
          let sx = x + k - kHalf;
          // Mirror padding
          if (sx < 0) sx = -sx;
          else if (sx >= width) sx = 2 * width - 2 - sx;
          sum += input[rowOff + sx] * kernel[k];
        }
        output[rowOff + x] = sum / FILTER_SUM;
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let k = 0; k < kLen; k++) {
          let sy = y + k - kHalf;
          if (sy < 0) sy = -sy;
          else if (sy >= height) sy = 2 * height - 2 - sy;
          sum += input[sy * width + x] * kernel[k];
        }
        output[y * width + x] = sum / FILTER_SUM;
      }
    }
  }

  return output;
}

/** Apply 2D separable convolution (vertical then horizontal) */
function convolve2D(
  input: Float64Array, width: number, height: number,
  kernel: Float64Array,
): Float64Array {
  const temp = convolve1D(input, width, height, kernel, false);
  return convolve1D(temp, width, height, kernel, true);
}

/**
 * Downsample by 2 with anti-aliasing prefilter.
 * libvmaf uses the destination scale's filter for downsampling:
 *   0→1: VIF_FILTER_1 (9-tap), 1→2: VIF_FILTER_2 (5-tap), 2→3: VIF_FILTER_3 (3-tap)
 */
function downsample2x(
  input: Float64Array, width: number, height: number,
  filter: Float64Array,
): { data: Float64Array; width: number; height: number } {
  const filtered = convolve2D(input, width, height, filter);
  const dw = Math.floor(width / 2);
  const dh = Math.floor(height / 2);
  const output = new Float64Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      output[y * dw + x] = filtered[(y * 2) * width + (x * 2)];
    }
  }
  return { data: output, width: dw, height: dh };
}

// ============================================================================
// VIF (Visual Information Fidelity)
// ============================================================================

interface VifScaleResult {
  num: number;
  den: number;
}

/**
 * Compute VIF at one scale.
 * Returns numerator and denominator for this scale's VIF contribution.
 */
function computeVifScale(
  ref: Float64Array, dis: Float64Array,
  width: number, height: number,
  kernel: Float64Array,
  enhGainLimit: number,
): VifScaleResult {
  // Compute local statistics via separable convolution
  const mu1 = convolve2D(ref, width, height, kernel);
  const mu2 = convolve2D(dis, width, height, kernel);

  // Compute E[ref^2], E[dis^2], E[ref*dis]
  const refSq = new Float64Array(width * height);
  const disSq = new Float64Array(width * height);
  const refDis = new Float64Array(width * height);
  for (let i = 0; i < ref.length; i++) {
    refSq[i] = ref[i] * ref[i];
    disSq[i] = dis[i] * dis[i];
    refDis[i] = ref[i] * dis[i];
  }

  const xx = convolve2D(refSq, width, height, kernel);
  const yy = convolve2D(disSq, width, height, kernel);
  const xy = convolve2D(refDis, width, height, kernel);

  // Accumulate VIF numerator and denominator
  let numAccum = 0;
  let denAccum = 0;

  for (let i = 0; i < width * height; i++) {
    const mu1Sq = mu1[i] * mu1[i];
    const mu2Sq = mu2[i] * mu2[i];
    const mu1Mu2 = mu1[i] * mu2[i];
    const sigma1Sq = xx[i] - mu1Sq;
    const sigma2Sq = Math.max(yy[i] - mu2Sq, 0);
    const sigma12 = xy[i] - mu1Mu2;

    if (sigma1Sq >= VIF_SIGMA_NSQ) {
      // Sufficient reference signal — log-domain VIF
      denAccum += Math.log2(1.0 + sigma1Sq / VIF_SIGMA_NSQ);

      if (sigma12 > 0 && sigma2Sq > 0) {
        let g = sigma12 / sigma1Sq;
        const svSq = Math.max(sigma2Sq - g * sigma12, 0);
        g = Math.min(g, enhGainLimit);
        numAccum += Math.log2(1.0 + g * g * sigma1Sq / (svSq + VIF_SIGMA_NSQ));
      }
      // else: numAccum += 0 (no contribution)
    } else {
      // Noise-dominated region: flat reference
      // den contribution = 1 bit (minimal information)
      // num contribution = 1 - sigma2_sq / sigma_nsq (penalize distorted variance)
      denAccum += 1.0;
      numAccum += 1.0 - sigma2Sq / VIF_SIGMA_NSQ;
    }
  }

  return {
    num: numAccum,
    den: denAccum,
  };
}

/**
 * Compute VIF at 4 scales. Returns per-scale VIF scores.
 */
export function computeVif(
  ref: Float64Array, dis: Float64Array,
  width: number, height: number,
  enhGainLimit: number = VIF_ENHN_GAIN_LIMIT_DEFAULT,
): [number, number, number, number] {
  const scores: [number, number, number, number] = [0, 0, 0, 0];

  let curRef = ref;
  let curDis = dis;
  let w = width;
  let h = height;

  for (let scale = 0; scale < 4; scale++) {
    // Skip scales where the image is too small for meaningful statistics
    if (w < VIF_FILTERS[scale].length || h < VIF_FILTERS[scale].length) {
      scores[scale] = 1.0; // Perfect score for unavailable scales
      continue;
    }

    const result = computeVifScale(curRef, curDis, w, h, VIF_FILTERS[scale], enhGainLimit);
    scores[scale] = result.den > 0 ? result.num / result.den : 1.0;

    // Downsample for next scale using the destination scale's filter
    if (scale < 3) {
      if (w < 10 || h < 10) {
        // Too small to downsample further
        for (let s = scale + 1; s < 4; s++) scores[s] = 1.0;
        break;
      }
      const dsFilter = VIF_FILTERS[scale + 1];
      const dsRef = downsample2x(curRef, w, h, dsFilter);
      const dsDis = downsample2x(curDis, w, h, dsFilter);
      curRef = dsRef.data;
      curDis = dsDis.data;
      w = dsRef.width;
      h = dsRef.height;
    }
  }

  return scores;
}

// ============================================================================
// ADM (Additive Detail/Distortion Metric)
// ============================================================================

interface DwtBands {
  /** LL (approximation) */
  a: Float64Array;
  /** LH (horizontal detail) */
  h: Float64Array;
  /** HL (vertical detail) */
  v: Float64Array;
  /** HH (diagonal detail) */
  d: Float64Array;
  width: number;
  height: number;
}

/**
 * 1-level 2D Daubechies-2 DWT. Produces 4 sub-bands at half resolution.
 */
function dwt2(
  input: Float64Array, width: number, height: number,
): DwtBands {
  const outW = Math.ceil(width / 2);
  const outH = Math.ceil(height / 2);

  // Step 1: Vertical filtering + downsampling
  const loVert = new Float64Array(outH * width);
  const hiVert = new Float64Array(outH * width);

  for (let x = 0; x < width; x++) {
    for (let oy = 0; oy < outH; oy++) {
      const y = oy * 2;
      let loSum = 0, hiSum = 0;
      for (let k = 0; k < 4; k++) {
        let sy = y + k;
        // Mirror padding
        if (sy >= height) sy = 2 * height - 2 - sy;
        if (sy < 0) sy = -sy;
        const val = input[sy * width + x];
        loSum += val * DWT_LO[k];
        hiSum += val * DWT_HI[k];
      }
      loVert[oy * width + x] = loSum;
      hiVert[oy * width + x] = hiSum;
    }
  }

  // Step 2: Horizontal filtering + downsampling on both lo and hi
  const a = new Float64Array(outH * outW); // LL
  const h = new Float64Array(outH * outW); // LH
  const v = new Float64Array(outH * outW); // HL
  const d = new Float64Array(outH * outW); // HH

  for (let y = 0; y < outH; y++) {
    const loRow = y * width;
    const hiRow = y * width;
    for (let ox = 0; ox < outW; ox++) {
      const x = ox * 2;
      let aSum = 0, hSum = 0, vSum = 0, dSum = 0;
      for (let k = 0; k < 4; k++) {
        let sx = x + k;
        if (sx >= width) sx = 2 * width - 2 - sx;
        if (sx < 0) sx = -sx;
        const loVal = loVert[loRow + sx];
        const hiVal = hiVert[hiRow + sx];
        aSum += loVal * DWT_LO[k]; // LL
        hSum += loVal * DWT_HI[k]; // LH (lo-vert, hi-horiz)
        vSum += hiVal * DWT_LO[k]; // HL (hi-vert, lo-horiz)
        dSum += hiVal * DWT_HI[k]; // HH
      }
      const idx = y * outW + ox;
      a[idx] = aSum;
      h[idx] = hSum;
      v[idx] = vSum;
      d[idx] = dSum;
    }
  }

  return { a, h, v, d, width: outW, height: outH };
}

/**
 * Compute the CSF (Contrast Sensitivity Function) weight for a given scale and orientation.
 * Returns 1/Q (the reciprocal of the quantization step).
 */
function computeCsfWeight(scale: number, orientation: number): number {
  const r = ADM_NORM_VIEW_DIST * ADM_REF_DISPLAY_HEIGHT * Math.PI / 180;
  const freq = Math.pow(2, scale + 1) * ADM_CSF_F0 * ADM_CSF_G[orientation] / r;
  const logFreq = Math.log10(freq);
  const Q = 2 * ADM_CSF_A * Math.pow(10, ADM_CSF_K * logFreq * logFreq) / ADM_BASIS_AMP[scale][orientation];
  return 1.0 / Q;
}

/**
 * Compute ADM2 score from reference and distorted grayscale images.
 *
 * Follows libvmaf's algorithm:
 *   den = L3 norm of CSF-weighted REFERENCE detail (total signal energy)
 *   num = L3 norm of CSF-weighted, contrast-masked RESTORED signal (preserved energy)
 *   ADM2 = num / den  (~1.0 for clean, <1.0 for distorted)
 *
 * Decouple: per-coefficient gain clamped to [0,1], with angle-based
 * enhancement check (gain up to enhGainLimit when direction < 1°).
 * Masking: from artifact energy (not reference), cross-orientation.
 */
export function computeAdm2(
  ref: Float64Array, dis: Float64Array,
  width: number, height: number,
  enhGainLimit: number = ADM_ENHN_GAIN_LIMIT_DEFAULT,
): number {
  // Pre-compute CSF weights for all scales and orientations.
  // libvmaf uses theta=1 for BOTH H and V (g[1]=1.0, amp[s][1]),
  // and theta=2 for D (g[2]=0.534, amp[s][2]).
  // Our ADM_CSF_G and ADM_BASIS_AMP arrays are indexed by theta (0=LL,1=LH,2=HH,3=HL).
  const csfWeights: number[][] = [];
  for (let s = 0; s < 4; s++) {
    csfWeights.push([
      computeCsfWeight(s, 1), // h → theta=1 (same as V)
      computeCsfWeight(s, 1), // v → theta=1
      computeCsfWeight(s, 2), // d → theta=2
    ]);
  }

  // 4-level DWT decomposition
  const refBands: DwtBands[] = [];
  const disBands: DwtBands[] = [];

  let curRef = ref;
  let curDis = dis;
  let w = width;
  let h = height;

  for (let s = 0; s < 4; s++) {
    if (w < 4 || h < 4) break; // Too small for DWT
    const rb = dwt2(curRef, w, h);
    const db = dwt2(curDis, w, h);
    refBands.push(rb);
    disBands.push(db);
    curRef = rb.a;
    curDis = db.a;
    w = rb.width;
    h = rb.height;
  }

  const numScales = refBands.length;
  let totalNum = 0;
  let totalDen = 0;

  // cos²(1°) for enhancement angle check
  const COS_1DEG_SQ = Math.cos(Math.PI / 180) ** 2;

  for (let s = 0; s < numScales; s++) {
    const rb = refBands[s];
    const db = disBands[s];
    const bw = rb.width;
    const bh = rb.height;

    // Border exclusion (libvmaf: floor(dim * 0.1 - 0.5))
    const left = Math.max(1, Math.floor(bw * ADM_BORDER_FACTOR - 0.5));
    const top = Math.max(1, Math.floor(bh * ADM_BORDER_FACTOR - 0.5));
    const right = bw - left;
    const bottom = bh - top;
    const area = Math.max(1, (bottom - top) * (right - left));

    // === Step 1: Decouple — restored signal + artifact ===
    const n = bw * bh;
    const restored: Float64Array[] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    const artifactBands: Float64Array[] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];

    const refH = rb.h, refV = rb.v, refD = rb.d;
    const disH = db.h, disV = db.v, disD = db.d;

    for (let i = 0; i < n; i++) {
      const oh = refH[i], ov = refV[i], od = refD[i];
      const th = disH[i], tv = disV[i], td = disD[i];
      const eps = 1e-30;

      // Per-orientation gain clamped to [0, 1]
      const kh = Math.max(0, Math.min(th / (oh + eps), 1.0));
      const kv = Math.max(0, Math.min(tv / (ov + eps), 1.0));
      const kd = Math.max(0, Math.min(td / (od + eps), 1.0));

      let rstH = kh * oh;
      let rstV = kv * ov;
      let rstD = kd * od;

      // Enhancement angle check: angle between (oh,ov) and (th,tv) < 1°
      const otDp = oh * th + ov * tv;
      const oMagSq = oh * oh + ov * ov;
      const tMagSq = th * th + tv * tv;
      const angleFlag = otDp >= 0 && otDp * otDp >= COS_1DEG_SQ * oMagSq * tMagSq;

      if (angleFlag) {
        // Allow gain up to enhGainLimit for near-parallel distortion
        if (rstH > 0) rstH = Math.min(rstH * enhGainLimit, th);
        else if (rstH < 0) rstH = Math.max(rstH * enhGainLimit, th);
        if (rstV > 0) rstV = Math.min(rstV * enhGainLimit, tv);
        else if (rstV < 0) rstV = Math.max(rstV * enhGainLimit, tv);
        if (rstD > 0) rstD = Math.min(rstD * enhGainLimit, td);
        else if (rstD < 0) rstD = Math.max(rstD * enhGainLimit, td);
      }

      restored[0][i] = rstH;
      restored[1][i] = rstV;
      restored[2][i] = rstD;
      artifactBands[0][i] = th - rstH;
      artifactBands[1][i] = tv - rstV;
      artifactBands[2][i] = td - rstD;
    }

    // === Step 2: CSF-weight artifact → csf_a and csf_f = (1/30)*|csf_a| ===
    const csfArtifact: Float64Array[] = [];
    const csfFilter: Float64Array[] = [];

    for (let ori = 0; ori < 3; ori++) {
      const rf = csfWeights[s][ori];
      const csf_a = new Float64Array(n);
      const csf_f = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        csf_a[i] = artifactBands[ori][i] * rf;
        csf_f[i] = Math.abs(csf_a[i]) / 30.0;
      }
      csfArtifact.push(csf_a);
      csfFilter.push(csf_f);
    }

    // === Step 3: Denominator — L3 norm of CSF-weighted REFERENCE ===
    const refBandsArr = [rb.h, rb.v, rb.d];
    for (let ori = 0; ori < 3; ori++) {
      const refBand = refBandsArr[ori];
      const rf = csfWeights[s][ori];
      let denAccum = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const v = Math.abs(refBand[y * bw + x] * rf);
          denAccum += v * v * v;
        }
      }
      totalDen += Math.cbrt(denAccum) + Math.cbrt(area / 32);
    }

    // === Step 4: Numerator — L3 norm of CSF-weighted, masked RESTORED signal ===
    for (let ori = 0; ori < 3; ori++) {
      const rf = csfWeights[s][ori];
      let numAccum = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const idx = y * bw + x;

          // CSF-weighted restored signal magnitude
          const rstCsf = Math.abs(restored[ori][idx] * rf);

          // Masking threshold: 3×3 of csf_f across ALL orientations
          // Center pixel weighted 2× (1/15 vs 1/30)
          let thr = 0;
          for (let o = 0; o < 3; o++) {
            for (let dy = -1; dy <= 1; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= bh) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                if (nx < 0 || nx >= bw) continue;
                if (dy === 0 && dx === 0) {
                  thr += Math.abs(csfArtifact[o][idx]) / 15.0;
                } else {
                  thr += csfFilter[o][ny * bw + nx];
                }
              }
            }
          }

          // Soft masking: subtract threshold
          const masked = Math.max(rstCsf - thr, 0);
          numAccum += masked * masked * masked;
        }
      }
      totalNum += Math.cbrt(numAccum) + Math.cbrt(area / 32);
    }
  }

  return totalDen > 0 ? totalNum / totalDen : 1.0;
}

// ============================================================================
// Motion
// ============================================================================

/**
 * Blur a grayscale image with the 5-tap Gaussian motion filter.
 */
export function motionBlur(
  gray: Float64Array, width: number, height: number,
): Float64Array {
  return convolve2D(gray, width, height, MOTION_FILTER);
}

/**
 * Compute motion score as mean absolute difference between two blurred frames.
 */
export function computeMotion(
  blurPrev: Float64Array, blurCurr: Float64Array,
  width: number, height: number,
): number {
  let sad = 0;
  const len = width * height;
  for (let i = 0; i < len; i++) {
    sad += Math.abs(blurPrev[i] - blurCurr[i]);
  }
  return sad / len;
}

// ============================================================================
// SVM Prediction
// ============================================================================

/**
 * Normalize raw features using the per-feature slopes and intercepts from the model.
 */
function normalizeFeatures(
  features: VmafFeatures,
  slopes: readonly number[],
  intercepts: readonly number[],
): number[] {
  const raw = [
    features.adm2,
    features.motion2,
    features.vif_scale0,
    features.vif_scale1,
    features.vif_scale2,
    features.vif_scale3,
  ];

  return raw.map((val, i) => slopes[i] * val + intercepts[i]);
}

/**
 * Run SVM prediction with RBF kernel on normalized features.
 */
function svmPredict(
  normFeatures: number[],
  supportVectors: readonly (readonly number[])[],
  rho: number,
): number {
  let sum = 0;

  for (let i = 0; i < supportVectors.length; i++) {
    const sv = supportVectors[i];
    const alpha = sv[0];

    // Compute squared distance ||x - sv||^2
    let distSq = 0;
    for (let j = 0; j < 6; j++) {
      const diff = normFeatures[j] - sv[j + 1];
      distSq += diff * diff;
    }

    // RBF kernel: exp(-gamma * ||x - sv||^2)
    sum += alpha * Math.exp(-VMAF_GAMMA * distSq);
  }

  // Subtract rho (note: rho is negative, so subtracting it adds)
  return sum - rho;
}

/**
 * Convert raw SVM output to final VMAF score.
 *
 * - HD/NEG: denormalize only (v0.6.1 normalization, no polynomial transform)
 * - Phone: denormalize + polynomial transform + out_gte_in (current v0.6.1 behavior)
 * - 4K: denormalize with 4K-specific constants (no transform in 4K model)
 */
function denormalizeScore(
  raw: number,
  model: VmafModelId,
): number {
  const slope = model === "4k" ? VMAF_4K_SCORE_SLOPE : SCORE_SLOPE;
  const intercept = model === "4k" ? VMAF_4K_SCORE_INTERCEPT : SCORE_INTERCEPT;

  // Denormalize: inverse of linear_rescale normalization
  const score = (raw - intercept) / slope;

  if (model === "phone") {
    // Polynomial transform (score_transform from v0.6.1 model)
    const transformed = TRANSFORM_P0 + TRANSFORM_P1 * score + TRANSFORM_P2 * score * score;
    // Rectification: out_gte_in
    const rectified = Math.max(transformed, score);
    return Math.max(0, Math.min(100, rectified));
  }

  // HD, NEG, 4K: no polynomial transform
  return Math.max(0, Math.min(100, score));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create initial VMAF state (for motion feature temporal buffering).
 */
export function createVmafState(): VmafState {
  return { prevBlurred: null, prevMotion: 0 };
}

/**
 * Compute VMAF score for a single frame pair.
 *
 * @param refGray  - Reference frame grayscale [0,255], Float64Array of width*height
 * @param disGray  - Distorted frame grayscale [0,255], Float64Array of width*height
 * @param width    - Frame width
 * @param height   - Frame height
 * @param state    - Mutable state for motion temporal buffering (pass null to skip motion)
 * @param model    - VMAF model to use (default: "phone" for backward compatibility)
 * @returns VMAF result with score and raw features
 */
export function computeVmaf(
  refGray: Float64Array, disGray: Float64Array,
  width: number, height: number,
  state: VmafState | null,
  model: VmafModelId = "phone",
): VmafResult {
  // NEG model uses enhancement gain limit of 1.0; all others use 100.0
  const enhGainLimit = model === "neg" ? 1.0 : 100.0;

  // 1. VIF at 4 scales
  const [vif0, vif1, vif2, vif3] = computeVif(refGray, disGray, width, height, enhGainLimit);

  // 2. ADM2
  const adm2 = computeAdm2(refGray, disGray, width, height, enhGainLimit);

  // 3. Motion
  let motion2 = 0;
  if (state) {
    const blurred = motionBlur(disGray, width, height);
    if (state.prevBlurred) {
      const motionScore = computeMotion(state.prevBlurred, blurred, width, height);
      motion2 = Math.min(motionScore, state.prevMotion);
      state.prevMotion = motionScore;
    }
    state.prevBlurred = blurred;
  }

  // 4. Assemble features
  const features: VmafFeatures = {
    vif_scale0: vif0,
    vif_scale1: vif1,
    vif_scale2: vif2,
    vif_scale3: vif3,
    adm2,
    motion2,
  };

  // 5. Select model-specific SVM constants
  const slopes = model === "4k" ? VMAF_4K_FEATURE_SLOPES : FEATURE_SLOPES;
  const intercepts = model === "4k" ? VMAF_4K_FEATURE_INTERCEPTS : FEATURE_INTERCEPTS;
  const supportVectors = model === "4k" ? VMAF_4K_SUPPORT_VECTORS : SUPPORT_VECTORS;
  const rho = model === "4k" ? VMAF_4K_RHO : VMAF_RHO;

  // 6. Normalize, predict, denormalize
  const normFeatures = normalizeFeatures(features, slopes, intercepts);
  const raw = svmPredict(normFeatures, supportVectors, rho);
  const score = denormalizeScore(raw, model);

  return { score, features };
}

/**
 * Compute VMAF directly from two RGBA ImageData objects.
 * Convenience wrapper that handles grayscale conversion.
 */
export function computeVmafFromImageData(
  dataA: ImageData, dataB: ImageData,
  state: VmafState | null,
  model: VmafModelId = "phone",
): VmafResult {
  const { width, height } = dataA;
  const refGray = rgbaToGray(dataA.data, width, height);
  const disGray = rgbaToGray(dataB.data, width, height);
  return computeVmaf(refGray, disGray, width, height, state, model);
}

/**
 * useDiffRenderer — WebGL2-based per-pixel difference map between two video elements.
 *
 * Renders `abs(A - B) * amplify` with a selectable palette (grayscale, temperature,
 * PSNR, SSIM) onto a canvas overlay. The fragment shader normalizes the RGB
 * difference by sqrt(3) so the result is 0..1, then applies amplification and
 * palette mapping. The SSIM palette blends the heatmap over video B so the user
 * sees the actual content with a quality-colored tint.
 *
 * Rendering is scheduled on `seeked` events when paused, or via a rAF loop when
 * playing. Each frame takes <1ms (GPU-to-GPU texture upload via texImage2D).
 *
 * CPU-side metrics (PSNR + SSIM) are computed every frame when paused, and at
 * an adaptive rate during playback. An EMA of fireMetrics() cost is tracked;
 * the skip interval is adjusted so metrics consume at most ~2ms of average
 * per-frame budget (e.g. 8ms cost → compute every 4th frame). The heatmap
 * and readout always update, just at a lower rate on slow machines.
 *
 * GL resources are created lazily when `active` becomes true (canvas must be visible
 * for a valid WebGL2 context), and destroyed when deactivated or on unmount.
 */
import { useEffect, useRef } from "react";
import { computeVmafFromImageData, createVmafState } from "../utils/vmafCore";
import type { VmafState, VmafModelId } from "../utils/vmafCore";

export type DiffPalette = "grayscale" | "temperature" | "psnr" | "ssim" | "msssim" | "vmaf";
export type DiffAmplification = 1 | 2 | 4 | 8;

/* eslint-disable @stylistic/indent */
const VERT_SRC = [
"#version 300 es",
"in vec2 a_position;",
"out vec2 v_texCoord;",
"void main() {",
"  gl_Position = vec4(a_position, 0.0, 1.0);",
"  v_texCoord = vec2(a_position.x * 0.5 + 0.5, 1.0 - (a_position.y * 0.5 + 0.5));",
"}",
].join("\n");

const FRAG_SRC = [
"#version 300 es",
"precision mediump float;",
"in vec2 v_texCoord;",
"uniform sampler2D u_texA;",
"uniform sampler2D u_texB;",
"uniform sampler2D u_texSsim;",
"uniform float u_amplify;",
"uniform int u_palette;",
"out vec4 fragColor;",
"",
"void main() {",
"  vec3 colA = texture(u_texA, v_texCoord).rgb;",
"  vec3 colB = texture(u_texB, v_texCoord).rgb;",
"  float diff = length(colA - colB) / 1.732;",
"  float val = clamp(diff * u_amplify, 0.0, 1.0);",
"",
"  vec3 color;",
"  if (u_palette == 1) {",
"    if (val < 0.5) {",
"      float t = val * 2.0;",
"      color = mix(vec3(0.0, 0.0, 1.0), vec3(1.0, 1.0, 1.0), t);",
"    } else {",
"      float t = (val - 0.5) * 2.0;",
"      color = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.0, 0.0), t);",
"    }",
"  } else if (u_palette == 2) {",
// PSNR heatmap: compute per-pixel PSNR in dB, map to 5-stop gradient
"    vec3 d = colA - colB;",
"    float mse = dot(d, d) / 3.0;",
"    float ampMse = mse / (u_amplify * u_amplify);",
"    float psnr = clamp(-10.0 * log(ampMse + 1e-10) / log(10.0), 0.0, 60.0);",
// 5 stops: ≤15 magenta, 20 red, 30 yellow, 40 green, ≥50 dark green
"    if (psnr >= 50.0) {",
"      color = vec3(0.0, 0.4, 0.0);",
"    } else if (psnr >= 40.0) {",
"      float t = (psnr - 40.0) / 10.0;",
"      color = mix(vec3(0.0, 0.8, 0.0), vec3(0.0, 0.4, 0.0), t);",
"    } else if (psnr >= 30.0) {",
"      float t = (psnr - 30.0) / 10.0;",
"      color = mix(vec3(1.0, 1.0, 0.0), vec3(0.0, 0.8, 0.0), t);",
"    } else if (psnr >= 20.0) {",
"      float t = (psnr - 20.0) / 10.0;",
"      color = mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), t);",
"    } else {",
"      float t = clamp((psnr - 15.0) / 5.0, 0.0, 1.0);",
"      color = mix(vec3(1.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0), t);",
"    }",
"  } else if (u_palette == 3) {",
// SSIM heatmap blended over video B: heatmap color overlaid on the encoded video
// so the user sees the actual content with quality-colored tint.
// High SSIM (green) = mostly transparent, low SSIM (red/magenta) = more opaque.
"    float s = texture(u_texSsim, v_texCoord).r;",
"    vec3 heatColor;",
"    if (s >= 0.99) {",
"      heatColor = vec3(0.0, 0.4, 0.0);",
"    } else if (s >= 0.95) {",
"      float t = (s - 0.95) / 0.04;",
"      heatColor = mix(vec3(0.0, 0.8, 0.0), vec3(0.0, 0.4, 0.0), t);",
"    } else if (s >= 0.85) {",
"      float t = (s - 0.85) / 0.10;",
"      heatColor = mix(vec3(1.0, 1.0, 0.0), vec3(0.0, 0.8, 0.0), t);",
"    } else if (s >= 0.70) {",
"      float t = (s - 0.70) / 0.15;",
"      heatColor = mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), t);",
"    } else {",
"      float t = clamp((s - 0.50) / 0.20, 0.0, 1.0);",
"      heatColor = mix(vec3(1.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0), t);",
"    }",
// Blend: opacity ramps from 0.15 (high quality) to 0.7 (low quality)
// so good regions show mostly video, bad regions show mostly heatmap
"    float opacity = mix(0.7, 0.15, clamp((s - 0.50) / 0.49, 0.0, 1.0));",
"    color = mix(colB, heatColor, opacity);",
"  } else {",
"    color = vec3(val);",
"  }",
"",
"  fragColor = vec4(color, 1.0);",
"}",
].join("\n");
/* eslint-enable @stylistic/indent */

interface UseDiffRendererParams {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoA: HTMLVideoElement | null;
  videoB: HTMLVideoElement;
  active: boolean;
  paused: boolean;
  amplification: DiffAmplification;
  palette: DiffPalette;
  vmafModel?: VmafModelId;
  onPsnr?: (psnr: number | null) => void;
  onSsim?: (ssim: number | null) => void;
  onMsSsim?: (msSsim: number | null) => void;
  onVmaf?: (vmaf: number | null) => void;
}

interface GlState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texA: WebGLTexture;
  texB: WebGLTexture;
  /** Back-buffer textures for triple-buffering during RVFC playback */
  texABack: WebGLTexture;
  texBBack: WebGLTexture;
  /** Previous-back textures: keep one RVFC generation of history per video */
  texAPrev: WebGLTexture;
  texBPrev: WebGLTexture;
  texSsim: WebGLTexture;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  uAmp: WebGLUniformLocation | null;
  uPal: WebGLUniformLocation | null;
  uTexA: WebGLUniformLocation | null;
  uTexB: WebGLUniformLocation | null;
  uTexSsim: WebGLUniformLocation | null;
  /** Offscreen canvases for CPU-side metrics (reduced resolution) */
  metricsCanvasA: OffscreenCanvas;
  metricsCanvasB: OffscreenCanvas;
  metricsCtxA: OffscreenCanvasRenderingContext2D;
  metricsCtxB: OffscreenCanvasRenderingContext2D;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("Shader compile error:", gl.getShaderInfoLog(sh) || "(no details)");
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function initGl(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, antialias: false });
  if (!gl) {
    console.warn("useDiffRenderer: WebGL2 not available");
    return null;
  }

  const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vert || !frag) {
    if (vert) gl.deleteShader(vert);
    if (frag) gl.deleteShader(frag);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }

  const program = gl.createProgram()!;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Program link error:", gl.getProgramInfoLog(program) || "(no details)");
    gl.deleteProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }

  // Shaders can be detached+deleted after linking — the program retains them
  gl.detachShader(program, vert);
  gl.detachShader(program, frag);
  gl.deleteShader(vert);
  gl.deleteShader(frag);

  // Fullscreen quad VAO: two triangles covering [-1,1]
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Create six textures for video A and B (front + back + prev for triple-buffering)
  const textures: WebGLTexture[] = [];
  for (let i = 0; i < 6; i++) {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    textures.push(tex);
  }

  // SSIM heatmap texture (R8, small resolution — GPU bilinear upscales for free)
  const texSsim = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, texSsim);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // Initialize with 1×1 placeholder (mid-gray = 0.5 SSIM)
  // R8 rows are 1 byte wide — UNPACK_ALIGNMENT must be 1 (default 4 causes row padding)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([128]));
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

  // Offscreen canvases for CPU-side metrics (reduced resolution, ~16:9 aspect)
  const METRICS_W = 120;
  const METRICS_H = 68;
  const metricsCanvasA = new OffscreenCanvas(METRICS_W, METRICS_H);
  const metricsCanvasB = new OffscreenCanvas(METRICS_W, METRICS_H);
  const metricsCtxA = metricsCanvasA.getContext("2d")!;
  const metricsCtxB = metricsCanvasB.getContext("2d")!;

  return {
    gl,
    program,
    texA: textures[0],
    texB: textures[1],
    texABack: textures[2],
    texBBack: textures[3],
    texAPrev: textures[4],
    texBPrev: textures[5],
    texSsim,
    vao,
    vbo,
    uAmp: gl.getUniformLocation(program, "u_amplify"),
    uPal: gl.getUniformLocation(program, "u_palette"),
    uTexA: gl.getUniformLocation(program, "u_texA"),
    uTexB: gl.getUniformLocation(program, "u_texB"),
    uTexSsim: gl.getUniformLocation(program, "u_texSsim"),
    metricsCanvasA,
    metricsCanvasB,
    metricsCtxA,
    metricsCtxB,
  };
}

function destroyGl(state: GlState) {
  const { gl, program, texA, texB, texABack, texBBack, texAPrev, texBPrev, texSsim, vao, vbo } = state;
  gl.deleteTexture(texA);
  gl.deleteTexture(texB);
  gl.deleteTexture(texABack);
  gl.deleteTexture(texBBack);
  gl.deleteTexture(texAPrev);
  gl.deleteTexture(texBPrev);
  gl.deleteTexture(texSsim);
  gl.deleteVertexArray(vao);
  gl.deleteBuffer(vbo);
  gl.deleteProgram(program);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
}

function paletteInt(p: DiffPalette): number {
  if (p === "temperature") return 1;
  if (p === "psnr") return 2;
  if (p === "ssim") return 3;
  if (p === "msssim") return 3; // same shader branch as SSIM
  if (p === "vmaf") return 3; // same heatmap-over-video blend
  return 0;
}

/** Compute overall frame PSNR (dB) from two ImageData objects */
function computePsnrFromData(dataA: ImageData, dataB: ImageData): number | null {
  const pixelsA = dataA.data;
  const pixelsB = dataB.data;
  let sumSqDiff = 0;
  let pixelCount = 0;
  for (let i = 0; i < pixelsA.length; i += 4) {
    // RGB channels only (skip alpha)
    for (let c = 0; c < 3; c++) {
      const diff = (pixelsA[i + c] - pixelsB[i + c]) / 255;
      sumSqDiff += diff * diff;
    }
    pixelCount++;
  }
  const mse = sumSqDiff / (pixelCount * 3);
  if (mse < 1e-10) return 60; // identical frames, cap at 60 dB
  return -10 * Math.log10(mse);
}

// SSIM constants: k1=0.01, k2=0.03, bitDepth=8, L=255
const SSIM_C1 = (0.01 * 255) * (0.01 * 255); // 6.5025
const SSIM_C2 = (0.03 * 255) * (0.03 * 255); // 58.5225
const SSIM_WINDOW = 11;

/** Convert RGBA ImageData to Float32Array grayscale using BT.601 weights */
function toGrayscale(data: ImageData): Float32Array {
  const { width, height, data: rgba } = data;
  const gray = new Float32Array(width * height);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    gray[j] = (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2] + 128) >> 8;
  }
  return gray;
}

/** 2x box-filter downsample on Float32Array grayscale */
function downsampleGray(src: Float32Array, w: number, h: number): { data: Float32Array; width: number; height: number } {
  const dw = Math.floor(w / 2);
  const dh = Math.floor(h / 2);
  const dst = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = x * 2;
      const sy = y * 2;
      dst[y * dw + x] = (
        src[sy * w + sx] + src[sy * w + sx + 1] +
        src[(sy + 1) * w + sx] + src[(sy + 1) * w + sx + 1]
      ) * 0.25;
    }
  }
  return { data: dst, width: dw, height: dh };
}

/** Compute per-block luminance (l) and contrast-structure (cs) components from grayscale arrays */
function computeScaleComponents(
  grayA: Float32Array, grayB: Float32Array, w: number, h: number,
): { l: Float32Array; cs: Float32Array; mapW: number; mapH: number } {
  const mapW = Math.ceil(w / SSIM_WINDOW);
  const mapH = Math.ceil(h / SSIM_WINDOW);
  const size = mapW * mapH;
  const l = new Float32Array(size);
  const cs = new Float32Array(size);
  let idx = 0;

  for (let by = 0; by < h; by += SSIM_WINDOW) {
    for (let bx = 0; bx < w; bx += SSIM_WINDOW) {
      const ww = Math.min(SSIM_WINDOW, w - bx);
      const wh = Math.min(SSIM_WINDOW, h - by);
      const n = ww * wh;

      let s1 = 0, s2 = 0, sq1 = 0, sq2 = 0, cross = 0;
      for (let dy = 0; dy < wh; dy++) {
        const rowStart = (by + dy) * w + bx;
        for (let dx = 0; dx < ww; dx++) {
          const px = rowStart + dx;
          const g1 = grayA[px];
          const g2 = grayB[px];
          s1 += g1; s2 += g2;
          sq1 += g1 * g1; sq2 += g2 * g2;
          cross += g1 * g2;
        }
      }

      const avg1 = s1 / n;
      const avg2 = s2 / n;
      const var1 = sq1 / n - avg1 * avg1;
      const var2 = sq2 / n - avg2 * avg2;
      const cov = cross / n - avg1 * avg2;

      l[idx] = (2 * avg1 * avg2 + SSIM_C1) / (avg1 * avg1 + avg2 * avg2 + SSIM_C1);
      cs[idx] = (2 * cov + SSIM_C2) / (var1 + var2 + SSIM_C2);
      idx++;
    }
  }

  return { l, cs, mapW, mapH };
}

// MS-SSIM weights (Wang et al. 2003) for 3 scales, renormalized from [0.0448, 0.2856, 0.3001]
const MSSSIM_WEIGHTS = [0.071, 0.453, 0.476];

/** Compute MS-SSIM map from two ImageData objects at the metrics resolution */
function computeMsSsimMap(
  dataA: ImageData, dataB: ImageData,
): { meanMsSsim: number; mapBytes: Uint8Array; mapWidth: number; mapHeight: number } | null {
  const { width, height } = dataA;

  // Convert to grayscale
  let grayA = toGrayscale(dataA);
  let grayB = toGrayscale(dataB);
  let w = width;
  let h = height;

  // Compute components at each scale, then downsample
  const scales: { l: Float32Array; cs: Float32Array; mapW: number; mapH: number }[] = [];
  for (let s = 0; s < 3; s++) {
    scales.push(computeScaleComponents(grayA, grayB, w, h));
    if (s < 2) {
      const dA = downsampleGray(grayA, w, h);
      const dB = downsampleGray(grayB, w, h);
      grayA = dA.data; grayB = dB.data;
      w = dA.width; h = dA.height;
    }
  }

  // Finest grid (scale 0)
  const fineW = scales[0].mapW;
  const fineH = scales[0].mapH;
  const mapSize = fineW * fineH;
  const mapBytes = new Uint8Array(mapSize);
  let totalMsSsim = 0;

  for (let i = 0; i < mapSize; i++) {
    const fineX = i % fineW;
    const fineY = Math.floor(i / fineW);

    // Combine: MS-SSIM = l_M^w_M * product(cs_j^w_j)
    let msSsim = 1;
    for (let s = 0; s < 3; s++) {
      const sc = scales[s];
      // Nearest-neighbor upsample: map fine grid position to this scale's grid
      const sx = Math.min(sc.mapW - 1, Math.floor(fineX * sc.mapW / fineW));
      const sy = Math.min(sc.mapH - 1, Math.floor(fineY * sc.mapH / fineH));
      const si = sy * sc.mapW + sx;

      const csVal = Math.max(0, sc.cs[si]);
      msSsim *= Math.pow(csVal, MSSSIM_WEIGHTS[s]);

      // At the coarsest scale (M=2), also include luminance
      if (s === 2) {
        const lVal = Math.max(0, sc.l[si]);
        msSsim *= Math.pow(lVal, MSSSIM_WEIGHTS[s]);
      }
    }

    totalMsSsim += msSsim;
    mapBytes[i] = Math.max(0, Math.min(255, Math.round(msSsim * 255)));
  }

  return { meanMsSsim: totalMsSsim / mapSize, mapBytes, mapWidth: fineW, mapHeight: fineH };
}

/** Compute SSIM map using fused bezkrovny kernel — inline grayscale, in-place stats, zero intermediate allocations */
function computeSsimMap(
  dataA: ImageData,
  dataB: ImageData,
): { meanSsim: number; mapBytes: Uint8Array; mapWidth: number; mapHeight: number } | null {
  const { width, height } = dataA;
  const rgbaA = dataA.data;
  const rgbaB = dataB.data;

  const mapW = Math.ceil(width / SSIM_WINDOW);
  const mapH = Math.ceil(height / SSIM_WINDOW);
  const mapSize = mapW * mapH;
  const mapBytes = new Uint8Array(mapSize);

  let totalSsim = 0;
  let idx = 0;

  for (let by = 0; by < height; by += SSIM_WINDOW) {
    for (let bx = 0; bx < width; bx += SSIM_WINDOW) {
      const ww = Math.min(SSIM_WINDOW, width - bx);
      const wh = Math.min(SSIM_WINDOW, height - by);
      const n = ww * wh;

      let s1 = 0, s2 = 0, sq1 = 0, sq2 = 0, cross = 0;

      for (let dy = 0; dy < wh; dy++) {
        const rowStart = ((by + dy) * width + bx) * 4;
        for (let dx = 0; dx < ww; dx++) {
          const px = rowStart + dx * 4;
          const g1 = (77 * rgbaA[px] + 150 * rgbaA[px + 1] + 29 * rgbaA[px + 2] + 128) >> 8;
          const g2 = (77 * rgbaB[px] + 150 * rgbaB[px + 1] + 29 * rgbaB[px + 2] + 128) >> 8;
          s1 += g1; s2 += g2;
          sq1 += g1 * g1; sq2 += g2 * g2;
          cross += g1 * g2;
        }
      }

      const avg1 = s1 / n;
      const avg2 = s2 / n;
      const var1 = sq1 / n - avg1 * avg1;
      const var2 = sq2 / n - avg2 * avg2;
      const cov = cross / n - avg1 * avg2;

      const num = (2 * avg1 * avg2 + SSIM_C1) * (2 * cov + SSIM_C2);
      const den = (avg1 * avg1 + avg2 * avg2 + SSIM_C1) * (var1 + var2 + SSIM_C2);
      const ssimVal = num / den;

      totalSsim += ssimVal;
      mapBytes[idx++] = Math.max(0, Math.min(255, Math.round(ssimVal * 255)));
    }
  }

  return { meanSsim: totalSsim / mapSize, mapBytes, mapWidth: mapW, mapHeight: mapH };
}

export function useDiffRenderer({
  canvasRef,
  videoA,
  videoB,
  active,
  paused,
  amplification,
  palette,
  vmafModel = "phone",
  onPsnr,
  onSsim,
  onMsSsim,
  onVmaf,
}: UseDiffRendererParams) {
  // Stable refs for rAF render loop access (avoids stale closures)
  const ampRef = useRef(amplification);
  const palRef = useRef(palette);
  const pausedRef = useRef(paused);
  const activeRef = useRef(active);
  const vmafModelRef = useRef(vmafModel);
  const onPsnrRef = useRef(onPsnr);
  const onSsimRef = useRef(onSsim);
  const onMsSsimRef = useRef(onMsSsim);
  const onVmafRef = useRef(onVmaf);
  ampRef.current = amplification;
  palRef.current = palette;
  pausedRef.current = paused;
  activeRef.current = active;
  vmafModelRef.current = vmafModel;
  onPsnrRef.current = onPsnr;
  onSsimRef.current = onSsim;
  onMsSsimRef.current = onMsSsim;
  onVmafRef.current = onVmaf;

  const glStateRef = useRef<GlState | null>(null);
  const contextLostRef = useRef(false);

  /** Accumulated PSNR values keyed by time (rounded to 3dp to deduplicate) */
  const psnrHistory = useRef<Map<number, number>>(new Map());
  /** Accumulated SSIM values keyed by time (rounded to 3dp to deduplicate) */
  const ssimHistory = useRef<Map<number, number>>(new Map());
  /** Accumulated MS-SSIM values keyed by time (rounded to 3dp to deduplicate) */
  const msSsimHistory = useRef<Map<number, number>>(new Map());
  /** Accumulated VMAF values keyed by time (rounded to 3dp to deduplicate) */
  const vmafHistory = useRef<Map<number, number>>(new Map());
  /** VMAF temporal state for motion feature (must persist across frames) */
  const vmafStateRef = useRef<VmafState>(createVmafState());

  // Single effect: create GL when active, render, clean up when inactive/unmount.
  // Dependencies include active, paused, videoA, amplification, palette so the
  // render scheduling is refreshed when any of these change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active || !videoA) return;

    // Lazily create GL state (canvas must be visible for reliable context)
    let state = glStateRef.current;
    if (!state) {
      state = initGl(canvas);
      if (!state) return; // WebGL2 unavailable or shader compile failed
      glStateRef.current = state;

      // Context loss handlers
      const onLost = (e: Event) => {
        e.preventDefault();
        contextLostRef.current = true;
      };
      const onRestored = () => {
        contextLostRef.current = false;
        // Destroy stale state so next activation re-initializes
        if (glStateRef.current) {
          glStateRef.current = null;
        }
      };
      canvas.addEventListener("webglcontextlost", onLost);
      canvas.addEventListener("webglcontextrestored", onRestored);
    }

    const { gl, program, texA, texB, texABack, texBBack, texAPrev, texBPrev, texSsim, vao, uAmp, uPal, uTexA, uTexB, uTexSsim } = state;

    // Track whether we've ever uploaded valid (synced) textures.
    // Prevents drawing uninitialized textures before the first sync.
    let texturesUploaded = false;

    type RVFCMeta = { mediaTime: number };
    const hasRVFC = typeof HTMLVideoElement !== "undefined" &&
      "requestVideoFrameCallback" in HTMLVideoElement.prototype;

    /** Check whether both videos are presenting the same frame (paused mode) */
    const isVideoSynced = (): boolean => {
      if (!videoA || !videoB) return false;
      if (videoA.seeking || videoB.seeking) return false;
      return Math.abs(videoA.currentTime - videoB.currentTime) <= 0.016;
    };

    /** Resize GL canvas to match CSS layout * DPR. Returns false if zero-sized. */
    const resizeCanvas = (): boolean => {
      if (!canvas) return false;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w === 0 || h === 0) return false;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return true;
    };

    /** Issue the GL draw call (textures must already be bound/uploaded) */
    const drawQuad = () => {
      if (!canvas) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texSsim);
      gl.uniform1i(uTexA, 0);
      gl.uniform1i(uTexB, 1);
      gl.uniform1i(uTexSsim, 2);
      gl.uniform1f(uAmp, ampRef.current);
      gl.uniform1i(uPal, paletteInt(palRef.current));
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    };

    /** Upload both video textures to GPU from the video elements */
    const uploadVideoTextures = (): boolean => {
      if (!videoA) return false;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoA);
      } catch {
        return false;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoB);
      } catch {
        return false;
      }
      return true;
    };

    /**
     * Compute all metrics from pre-captured ImageData and upload heatmap.
     * Used by both the paused path (captures from video) and the RVFC path
     * (captures inside the frame callback).
     */
    const computeMetrics = (dataA: ImageData, dataB: ImageData) => {
      // PSNR
      const psnr = computePsnrFromData(dataA, dataB);
      onPsnrRef.current?.(psnr);
      if (psnr != null) {
        const roundedTime = Math.round(videoB.currentTime * 1000) / 1000;
        psnrHistory.current.set(roundedTime, psnr);
      }

      // SSIM
      const ssimResult = computeSsimMap(dataA, dataB);
      if (ssimResult) {
        onSsimRef.current?.(ssimResult.meanSsim);
        const roundedTime = Math.round(videoB.currentTime * 1000) / 1000;
        ssimHistory.current.set(roundedTime, ssimResult.meanSsim);
      } else {
        onSsimRef.current?.(null);
      }

      // MS-SSIM (only when palette is active — ~0.4ms extra cost)
      let uploadMap: { mapBytes: Uint8Array; mapWidth: number; mapHeight: number } | null = ssimResult;
      if (palRef.current === "msssim") {
        const msSsimResult = computeMsSsimMap(dataA, dataB);
        if (msSsimResult) {
          onMsSsimRef.current?.(msSsimResult.meanMsSsim);
          const roundedTime = Math.round(videoB.currentTime * 1000) / 1000;
          msSsimHistory.current.set(roundedTime, msSsimResult.meanMsSsim);
          uploadMap = msSsimResult;
        } else {
          onMsSsimRef.current?.(null);
        }
      } else {
        onMsSsimRef.current?.(null);
      }

      // VMAF (only when palette is active — ~3.5ms extra cost)
      if (palRef.current === "vmaf") {
        const vmafResult = computeVmafFromImageData(dataA, dataB, vmafStateRef.current, vmafModelRef.current);
        onVmafRef.current?.(vmafResult.score);
        const roundedTime = Math.round(videoB.currentTime * 1000) / 1000;
        vmafHistory.current.set(roundedTime, vmafResult.score);
      } else {
        onVmafRef.current?.(null);
      }

      // Upload heatmap as R8 texture (MS-SSIM map when active, SSIM otherwise)
      if (uploadMap) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, texSsim);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.R8,
          uploadMap.mapWidth, uploadMap.mapHeight, 0,
          gl.RED, gl.UNSIGNED_BYTE, uploadMap.mapBytes,
        );
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      }
    };

    if (paused) {
      // ── Paused: capture from video on seeked events ──
      const fireAndRender = () => {
        if (!videoA || !videoB || !state) return;
        if (!isVideoSynced()) return;
        const { metricsCtxA, metricsCtxB } = state;
        const mw = metricsCtxA.canvas.width;
        const mh = metricsCtxA.canvas.height;
        try {
          metricsCtxA.drawImage(videoA, 0, 0, mw, mh);
          metricsCtxB.drawImage(videoB, 0, 0, mw, mh);
        } catch {
          return;
        }
        computeMetrics(
          metricsCtxA.getImageData(0, 0, mw, mh),
          metricsCtxB.getImageData(0, 0, mw, mh),
        );
        if (!resizeCanvas()) return;
        if (uploadVideoTextures()) {
          texturesUploaded = true;
          drawQuad();
        }
      };

      fireAndRender();
      const onSeeked = () => fireAndRender();
      // Listen to BOTH videos' seeked events so we re-attempt after slave syncs.
      videoB.addEventListener("seeked", onSeeked);
      videoA.addEventListener("seeked", onSeeked);
      return () => {
        videoB.removeEventListener("seeked", onSeeked);
        videoA.removeEventListener("seeked", onSeeked);
      };
    } else if (hasRVFC && videoA) {
      // ── Playing + RVFC: triple-buffered capture with prev-frame matching ──
      //
      // Two independent compositors present frames at different vsync phases.
      // When they're 1 frame apart, RVFC-B fires PTS=N+1 then RVFC-A fires
      // PTS=N — the current pair always mismatches. But the PREVIOUS B
      // capture (from 2 callbacks ago) had PTS=N, which matches current A.
      //
      // Three textures per video (front/back/prev): RVFC rotates back→prev
      // and uploads to the new back. tryMatch checks 3 combinations:
      //   1. currentA vs currentB  (in-phase compositors)
      //   2. currentA vs prevB     (B ahead of A)
      //   3. prevA vs currentB     (A ahead of B)
      //
      // On match, the matched textures become front. The rAF drawLoop always
      // binds front textures — guaranteed PTS-matched pair.
      const { metricsCtxA, metricsCtxB } = state;
      const mw = metricsCtxA.canvas.width;
      const mh = metricsCtxA.canvas.height;

      // Per-video capture state: current + previous ImageData and PTS
      let capturedDataA: ImageData | null = null;
      let capturedPtsA = -Infinity;
      let prevDataA: ImageData | null = null;
      let prevPtsA = -Infinity;

      let capturedDataB: ImageData | null = null;
      let capturedPtsB = -Infinity;
      let prevDataB: ImageData | null = null;
      let prevPtsB = -Infinity;

      // Triple-buffer: 3 textures per video rotating through front/back/prev.
      // RVFC writes to back, prev keeps the previous RVFC upload, front is
      // stable for the drawLoop. On match, matched texture swaps to front.
      let frontA = texA;
      let backA = texABack;
      let prevTexA = texAPrev;

      let frontB = texB;
      let backB = texBBack;
      let prevTexB = texBPrev;

      let frontReady = false;

      // Guard against double-match within the same frame period (Bug 7).
      // When compositors are in phase, both RVFC callbacks fire for the same PTS.
      // The first match is correct (currentA+currentB). The second would match
      // currentB+prevA — but prevA is stale, causing frame oscillation.
      // Track the last matched PTS to skip redundant matches for the same frame.
      let lastMatchedPts = -Infinity;

      // ── Diagnostic counters (temporary — remove after debugging) ──
      let diagMatchCount = 0;
      let diagMatchPrev = 0; // matches via prev capture (desync recovery)
      let diagMissNoData = 0;
      let diagMissPts = 0;
      let diagCallbackA = 0;
      let diagCallbackB = 0;
      let diagDrawCount = 0;
      let diagMetricsMs = 0;
      let diagLastLogTime = performance.now();
      let diagPresentedA = 0;
      let diagPresentedB = 0;
      let diagLastPtsA = -Infinity;
      let diagLastPtsB = -Infinity;

      /** Try matching current and previous captures from both videos.
       *  On PTS match, compute metrics and swap matched textures to front. */
      const tryMatch = () => {
        const PTS_THRESH = 0.010;
        let matchDataA: ImageData | null = null;
        let matchDataB: ImageData | null = null;
        let matchTexA: WebGLTexture | null = null;
        let matchTexB: WebGLTexture | null = null;
        let matchPts = -Infinity;
        let usedPrev = false;

        // 1. Current A vs Current B (compositors in phase)
        if (capturedDataA && capturedDataB &&
            Math.abs(capturedPtsA - capturedPtsB) < PTS_THRESH) {
          matchDataA = capturedDataA;
          matchDataB = capturedDataB;
          matchTexA = backA;
          matchTexB = backB;
          matchPts = capturedPtsA;
        }
        // 2. Current A vs Previous B (B was ahead, prev B matches current A)
        else if (capturedDataA && prevDataB &&
                 Math.abs(capturedPtsA - prevPtsB) < PTS_THRESH) {
          matchDataA = capturedDataA;
          matchDataB = prevDataB;
          matchTexA = backA;
          matchTexB = prevTexB;
          matchPts = capturedPtsA;
          usedPrev = true;
        }
        // 3. Previous A vs Current B (A was ahead, prev A matches current B)
        else if (prevDataA && capturedDataB &&
                 Math.abs(prevPtsA - capturedPtsB) < PTS_THRESH) {
          matchDataA = prevDataA;
          matchDataB = capturedDataB;
          matchTexA = prevTexA;
          matchTexB = backB;
          matchPts = capturedPtsB;
          usedPrev = true;
        }

        if (!matchDataA || !matchDataB || !matchTexA || !matchTexB) {
          // Count diagnostic: noData if we have nothing, pts if we have data but no match
          if (!capturedDataA && !prevDataA || !capturedDataB && !prevDataB) {
            diagMissNoData++;
          } else {
            diagMissPts++;
          }
          return;
        }

        // Bug 7 guard: skip if we already matched this PTS. When compositors
        // are in phase, both RVFC callbacks fire for the same frame. The first
        // match (currentA+currentB) is correct. Without this guard, the second
        // callback would match currentB+prevA — swapping a stale prev texture
        // to front, causing visible frame oscillation.
        if (Math.abs(matchPts - lastMatchedPts) < PTS_THRESH) {
          return;
        }
        lastMatchedPts = matchPts;

        const t0 = performance.now();
        computeMetrics(matchDataA, matchDataB);
        diagMetricsMs += performance.now() - t0;
        diagMatchCount++;
        if (usedPrev) diagMatchPrev++;

        // Swap matched textures to front, recycle old front.
        // matchTexA could be backA or prevTexA; matchTexB could be backB or prevTexB.
        if (matchTexA === backA) {
          const tmp = frontA; frontA = backA; backA = tmp;
        } else {
          const tmp = frontA; frontA = prevTexA; prevTexA = tmp;
        }
        if (matchTexB === backB) {
          const tmp = frontB; frontB = backB; backB = tmp;
        } else {
          const tmp = frontB; frontB = prevTexB; prevTexB = tmp;
        }

        frontReady = true;
        texturesUploaded = true;
      };

      let rvfcIdA = -1;
      let rvfcIdB = -1;

      type RVFCMetaExt = RVFCMeta & { presentedFrames?: number };

      const onFrameA = (_: DOMHighResTimeStamp, meta: RVFCMetaExt) => {
        diagCallbackA++;
        diagLastPtsA = meta.mediaTime;
        if (meta.presentedFrames != null) diagPresentedA = meta.presentedFrames;

        // Shift current → prev (ImageData)
        prevDataA = capturedDataA;
        prevPtsA = capturedPtsA;

        // Capture at exact composition time
        try {
          metricsCtxA.drawImage(videoA!, 0, 0, mw, mh);
          capturedDataA = metricsCtxA.getImageData(0, 0, mw, mh);
          capturedPtsA = meta.mediaTime;
        } catch { /* ignore */ }

        // Rotate GPU textures: back→prev, reuse old prev for new back
        const tmp = prevTexA;
        prevTexA = backA;
        backA = tmp;
        // Upload to new back texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, backA);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoA!);
        } catch { /* ignore */ }

        tryMatch();
        rvfcIdA = (videoA as any).requestVideoFrameCallback(onFrameA);
      };

      const onFrameB = (_: DOMHighResTimeStamp, meta: RVFCMetaExt) => {
        diagCallbackB++;
        diagLastPtsB = meta.mediaTime;
        if (meta.presentedFrames != null) diagPresentedB = meta.presentedFrames;

        // Shift current → prev (ImageData)
        prevDataB = capturedDataB;
        prevPtsB = capturedPtsB;

        // Capture at exact composition time
        try {
          metricsCtxB.drawImage(videoB, 0, 0, mw, mh);
          capturedDataB = metricsCtxB.getImageData(0, 0, mw, mh);
          capturedPtsB = meta.mediaTime;
        } catch { /* ignore */ }

        // Rotate GPU textures: back→prev, reuse old prev for new back
        const tmp = prevTexB;
        prevTexB = backB;
        backB = tmp;
        // Upload to new back texture
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, backB);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoB);
        } catch { /* ignore */ }

        tryMatch();
        rvfcIdB = (videoB as any).requestVideoFrameCallback(onFrameB);
      };

      rvfcIdA = (videoA as any).requestVideoFrameCallback(onFrameA);
      rvfcIdB = (videoB as any).requestVideoFrameCallback(onFrameB);

      // rAF loop: bind front textures (guaranteed matched pair) and draw.
      // Between matches, repeats the last good pair — no freeze, no artifacts.
      let rafId: number;
      const drawLoop = () => {
        if (contextLostRef.current || !activeRef.current) return;
        if (!resizeCanvas()) { /* zero-size, retry next frame */ }
        else if (frontReady) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, frontA);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, frontB);
          drawQuad();
          diagDrawCount++;
        }

        // ── Diagnostic log every 2s ──
        const now = performance.now();
        if (now - diagLastLogTime >= 2000) {
          const elapsed = (now - diagLastLogTime) / 1000;
          const avgMs = diagMatchCount > 0 ? (diagMetricsMs / diagMatchCount).toFixed(1) : "0";
          console.log(
            `[DiffSync] ${elapsed.toFixed(1)}s: rvfcA=${diagCallbackA}(${(diagCallbackA / elapsed).toFixed(0)}/s) rvfcB=${diagCallbackB}(${(diagCallbackB / elapsed).toFixed(0)}/s) match=${diagMatchCount}(prev=${diagMatchPrev}) miss(noData=${diagMissNoData} pts=${diagMissPts}) draw=${diagDrawCount} metricsAvg=${avgMs}ms presentedA=${diagPresentedA} presentedB=${diagPresentedB} lastPtsA=${diagLastPtsA.toFixed(3)} lastPtsB=${diagLastPtsB.toFixed(3)}`,
          );
          diagCallbackA = diagCallbackB = 0;
          diagMatchCount = diagMatchPrev = diagMissNoData = diagMissPts = 0;
          diagDrawCount = 0;
          diagMetricsMs = 0;
          diagLastLogTime = now;
        }

        if (activeRef.current && !pausedRef.current) {
          rafId = requestAnimationFrame(drawLoop);
        }
      };
      rafId = requestAnimationFrame(drawLoop);

      return () => {
        (videoA as any).cancelVideoFrameCallback(rvfcIdA);
        (videoB as any).cancelVideoFrameCallback(rvfcIdB);
        cancelAnimationFrame(rafId);
      };
    } else {
      // ── Playing without RVFC: rAF-based fallback ──
      // Less accurate — currentTime check can't guarantee same compositor
      // frame, but it's the best we can do without RVFC.
      const fireMetricsFallback = () => {
        if (!videoA || !videoB || !state) return;
        if (!isVideoSynced()) return;
        const { metricsCtxA, metricsCtxB } = state;
        const mw = metricsCtxA.canvas.width;
        const mh = metricsCtxA.canvas.height;
        try {
          metricsCtxA.drawImage(videoA, 0, 0, mw, mh);
          metricsCtxB.drawImage(videoB, 0, 0, mw, mh);
        } catch {
          return;
        }
        computeMetrics(
          metricsCtxA.getImageData(0, 0, mw, mh),
          metricsCtxB.getImageData(0, 0, mw, mh),
        );
        if (uploadVideoTextures()) texturesUploaded = true;
      };

      let metricsSamples = 0;
      let metricsEma = 0;
      const TARGET_PER_FRAME_MS = 2;
      const EMA_ALPHA = 0.2;
      let skipInterval = 1;
      let frameCounter = 0;
      let rafId: number;

      const loop = () => {
        frameCounter++;
        if (frameCounter >= skipInterval) {
          frameCounter = 0;
          const t0 = performance.now();
          fireMetricsFallback();
          const elapsed = performance.now() - t0;
          metricsSamples++;
          metricsEma = metricsSamples === 1
            ? elapsed
            : metricsEma * (1 - EMA_ALPHA) + elapsed * EMA_ALPHA;
          skipInterval = Math.max(1, Math.ceil(metricsEma / TARGET_PER_FRAME_MS));
        }
        if (!resizeCanvas()) { /* zero-size */ }
        else if (texturesUploaded) drawQuad();
        if (activeRef.current && !pausedRef.current) {
          rafId = requestAnimationFrame(loop);
        }
      };
      rafId = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(rafId);
    }
  }, [active, videoA, videoB, paused, canvasRef, amplification, palette, vmafModel]);

  // Clear metric histories when diff mode is deactivated
  useEffect(() => {
    if (!active) {
      psnrHistory.current = new Map();
      ssimHistory.current = new Map();
      msSsimHistory.current = new Map();
      vmafHistory.current = new Map();
      vmafStateRef.current = createVmafState();
    }
  }, [active]);

  // Clear VMAF history when model changes (scores from different models aren't comparable)
  useEffect(() => {
    vmafHistory.current = new Map();
    vmafStateRef.current = createVmafState();
  }, [vmafModel]);

  // Destroy GL resources on unmount
  useEffect(() => {
    return () => {
      if (glStateRef.current) {
        destroyGl(glStateRef.current);
        glStateRef.current = null;
      }
    };
  }, []);

  return { psnrHistory, ssimHistory, msSsimHistory, vmafHistory };
}

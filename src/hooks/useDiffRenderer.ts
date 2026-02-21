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

export type DiffPalette = "grayscale" | "temperature" | "psnr" | "ssim";
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
  onPsnr?: (psnr: number | null) => void;
  onSsim?: (ssim: number | null) => void;
}

interface GlState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texA: WebGLTexture;
  texB: WebGLTexture;
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

  // Create two textures for video A and B
  const textures: WebGLTexture[] = [];
  for (let i = 0; i < 2; i++) {
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
  const { gl, program, texA, texB, texSsim, vao, vbo } = state;
  gl.deleteTexture(texA);
  gl.deleteTexture(texB);
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
  onPsnr,
  onSsim,
}: UseDiffRendererParams) {
  // Stable refs for rAF render loop access (avoids stale closures)
  const ampRef = useRef(amplification);
  const palRef = useRef(palette);
  const pausedRef = useRef(paused);
  const activeRef = useRef(active);
  const onPsnrRef = useRef(onPsnr);
  const onSsimRef = useRef(onSsim);
  ampRef.current = amplification;
  palRef.current = palette;
  pausedRef.current = paused;
  activeRef.current = active;
  onPsnrRef.current = onPsnr;
  onSsimRef.current = onSsim;

  const glStateRef = useRef<GlState | null>(null);
  const contextLostRef = useRef(false);

  /** Accumulated PSNR values keyed by time (rounded to 3dp to deduplicate) */
  const psnrHistory = useRef<Map<number, number>>(new Map());
  /** Accumulated SSIM values keyed by time (rounded to 3dp to deduplicate) */
  const ssimHistory = useRef<Map<number, number>>(new Map());

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

    const { gl, program, texA, texB, texSsim, vao, uAmp, uPal, uTexA, uTexB, uTexSsim } = state;

    const render = () => {
      if (contextLostRef.current || !activeRef.current) return;
      if (!canvas || !videoA || !videoB) return;

      // Resize canvas pixel buffer to match CSS layout * DPR
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w === 0 || h === 0) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      gl.viewport(0, 0, w, h);
      gl.useProgram(program);

      // Upload video A texture
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoA);
      } catch {
        return; // Cross-origin tainted or video not ready
      }

      // Upload video B texture
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoB);
      } catch {
        return;
      }

      // Bind SSIM texture to TEXTURE2 (already uploaded by fireMetrics)
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

    /** Draw both videos to offscreen canvases once, compute PSNR + SSIM, upload SSIM texture */
    const fireMetrics = () => {
      if (!videoA || !videoB || !state) return;
      const { metricsCtxA, metricsCtxB } = state;
      const w = metricsCtxA.canvas.width;
      const h = metricsCtxA.canvas.height;
      let dataA: ImageData;
      let dataB: ImageData;

      try {
        metricsCtxA.drawImage(videoA, 0, 0, w, h);
        metricsCtxB.drawImage(videoB, 0, 0, w, h);
        dataA = metricsCtxA.getImageData(0, 0, w, h);
        dataB = metricsCtxB.getImageData(0, 0, w, h);
      } catch {
        onPsnrRef.current?.(null);
        onSsimRef.current?.(null);
        return;
      }

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

        // Upload SSIM map as R8 texture
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, texSsim);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.R8,
          ssimResult.mapWidth, ssimResult.mapHeight, 0,
          gl.RED, gl.UNSIGNED_BYTE, ssimResult.mapBytes,
        );
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      } else {
        onSsimRef.current?.(null);
      }
    };

    if (paused) {
      // Compute metrics first so SSIM texture is ready, then render
      fireMetrics();
      render();
      const onSeeked = () => { fireMetrics(); render(); };
      videoB.addEventListener("seeked", onSeeked);
      return () => videoB.removeEventListener("seeked", onSeeked);
    } else {
      // Continuous rAF loop during playback with adaptive metrics throttle.
      // Metrics (PSNR + SSIM) are computed every Nth frame, where N is
      // dynamically adjusted based on measured cost. Target: metrics should
      // consume at most ~2ms of average per-frame budget. If fireMetrics()
      // takes 8ms, it runs every 4th frame (8/2=4). If it takes 0.5ms, every
      // frame. The heatmap and readout always update, just at a lower rate
      // on slow machines.
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
          fireMetrics();
          const elapsed = performance.now() - t0;
          metricsSamples++;
          metricsEma = metricsSamples === 1
            ? elapsed
            : metricsEma * (1 - EMA_ALPHA) + elapsed * EMA_ALPHA;
          skipInterval = Math.max(1, Math.ceil(metricsEma / TARGET_PER_FRAME_MS));
        }
        render();
        if (activeRef.current && !pausedRef.current) {
          rafId = requestAnimationFrame(loop);
        }
      };
      rafId = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(rafId);
    }
  }, [active, videoA, videoB, paused, canvasRef, amplification, palette]);

  // Clear metric histories when diff mode is deactivated
  useEffect(() => {
    if (!active) {
      psnrHistory.current = new Map();
      ssimHistory.current = new Map();
    }
  }, [active]);

  // Destroy GL resources on unmount
  useEffect(() => {
    return () => {
      if (glStateRef.current) {
        destroyGl(glStateRef.current);
        glStateRef.current = null;
      }
    };
  }, []);

  return { psnrHistory, ssimHistory };
}

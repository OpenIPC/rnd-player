/**
 * useDiffRenderer — WebGL2-based per-pixel difference map between two video elements.
 *
 * Renders `abs(A - B) * amplify` with a selectable palette (grayscale, temperature,
 * PSNR-clip) onto a canvas overlay. The fragment shader normalizes the RGB difference
 * by sqrt(3) so the result is 0..1, then applies amplification and palette mapping.
 *
 * Rendering is scheduled on `seeked` events when paused, or via a rAF loop when
 * playing. Each frame takes <1ms (GPU-to-GPU texture upload via texImage2D).
 *
 * GL resources are created lazily when `active` becomes true (canvas must be visible
 * for a valid WebGL2 context), and destroyed when deactivated or on unmount.
 */
import { useEffect, useRef } from "react";

export type DiffPalette = "grayscale" | "temperature" | "psnr";
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
}

interface GlState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texA: WebGLTexture;
  texB: WebGLTexture;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  uAmp: WebGLUniformLocation | null;
  uPal: WebGLUniformLocation | null;
  uTexA: WebGLUniformLocation | null;
  uTexB: WebGLUniformLocation | null;
  /** Offscreen canvases for CPU-side PSNR readout (reduced resolution) */
  psnrCanvasA: OffscreenCanvas;
  psnrCanvasB: OffscreenCanvas;
  psnrCtxA: OffscreenCanvasRenderingContext2D;
  psnrCtxB: OffscreenCanvasRenderingContext2D;
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

  // Offscreen canvases for CPU-side PSNR readout (160px wide, 16:9 aspect)
  const PSNR_W = 160;
  const PSNR_H = 90;
  const psnrCanvasA = new OffscreenCanvas(PSNR_W, PSNR_H);
  const psnrCanvasB = new OffscreenCanvas(PSNR_W, PSNR_H);
  const psnrCtxA = psnrCanvasA.getContext("2d")!;
  const psnrCtxB = psnrCanvasB.getContext("2d")!;

  return {
    gl,
    program,
    texA: textures[0],
    texB: textures[1],
    vao,
    vbo,
    uAmp: gl.getUniformLocation(program, "u_amplify"),
    uPal: gl.getUniformLocation(program, "u_palette"),
    uTexA: gl.getUniformLocation(program, "u_texA"),
    uTexB: gl.getUniformLocation(program, "u_texB"),
    psnrCanvasA,
    psnrCanvasB,
    psnrCtxA,
    psnrCtxB,
  };
}

function destroyGl(state: GlState) {
  const { gl, program, texA, texB, vao, vbo } = state;
  gl.deleteTexture(texA);
  gl.deleteTexture(texB);
  gl.deleteVertexArray(vao);
  gl.deleteBuffer(vbo);
  gl.deleteProgram(program);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
}

function paletteInt(p: DiffPalette): number {
  if (p === "temperature") return 1;
  if (p === "psnr") return 2;
  return 0;
}

/** Compute overall frame PSNR (dB) from two videos via offscreen canvases */
function computePsnr(
  videoA: HTMLVideoElement,
  videoB: HTMLVideoElement,
  ctxA: OffscreenCanvasRenderingContext2D,
  ctxB: OffscreenCanvasRenderingContext2D,
): number | null {
  const w = ctxA.canvas.width;
  const h = ctxA.canvas.height;
  try {
    ctxA.drawImage(videoA, 0, 0, w, h);
    ctxB.drawImage(videoB, 0, 0, w, h);
  } catch {
    return null; // cross-origin tainted or video not ready
  }
  const dataA = ctxA.getImageData(0, 0, w, h).data;
  const dataB = ctxB.getImageData(0, 0, w, h).data;
  let sumSqDiff = 0;
  let pixelCount = 0;
  for (let i = 0; i < dataA.length; i += 4) {
    // RGB channels only (skip alpha)
    for (let c = 0; c < 3; c++) {
      const diff = (dataA[i + c] - dataB[i + c]) / 255;
      sumSqDiff += diff * diff;
    }
    pixelCount++;
  }
  const mse = sumSqDiff / (pixelCount * 3);
  if (mse < 1e-10) return 60; // identical frames, cap at 60 dB
  return -10 * Math.log10(mse);
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
}: UseDiffRendererParams) {
  // Stable refs for rAF render loop access (avoids stale closures)
  const ampRef = useRef(amplification);
  const palRef = useRef(palette);
  const pausedRef = useRef(paused);
  const activeRef = useRef(active);
  const onPsnrRef = useRef(onPsnr);
  ampRef.current = amplification;
  palRef.current = palette;
  pausedRef.current = paused;
  activeRef.current = active;
  onPsnrRef.current = onPsnr;

  const glStateRef = useRef<GlState | null>(null);
  const contextLostRef = useRef(false);

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

    const { gl, program, texA, texB, vao, uAmp, uPal, uTexA, uTexB } = state;

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

      gl.uniform1i(uTexA, 0);
      gl.uniform1i(uTexB, 1);
      gl.uniform1f(uAmp, ampRef.current);
      gl.uniform1i(uPal, paletteInt(palRef.current));

      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    };

    const firePsnr = () => {
      if (!onPsnrRef.current || !videoA || !videoB) return;
      if (!state) return;
      const psnr = computePsnr(videoA, videoB, state.psnrCtxA, state.psnrCtxB);
      onPsnrRef.current(psnr);
    };

    if (paused) {
      // Render once now, then on each seeked event
      render();
      firePsnr();
      const onSeeked = () => { render(); firePsnr(); };
      videoB.addEventListener("seeked", onSeeked);
      return () => videoB.removeEventListener("seeked", onSeeked);
    } else {
      // Continuous rAF loop during playback (PSNR skipped — too expensive at 60fps)
      onPsnrRef.current?.(null);
      let rafId: number;
      const loop = () => {
        render();
        if (activeRef.current && !pausedRef.current) {
          rafId = requestAnimationFrame(loop);
        }
      };
      rafId = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(rafId);
    }
  }, [active, videoA, videoB, paused, canvasRef, amplification, palette]);

  // Destroy GL resources on unmount
  useEffect(() => {
    return () => {
      if (glStateRef.current) {
        destroyGl(glStateRef.current);
        glStateRef.current = null;
      }
    };
  }, []);
}

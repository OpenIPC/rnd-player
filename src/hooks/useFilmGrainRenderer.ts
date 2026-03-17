/**
 * useFilmGrainRenderer — WebGL2-based film grain synthesis overlay.
 *
 * Renders video + grain composite at 60fps using a pre-generated 512x512
 * seamlessly-tileable grain texture (AR process). The texture tiles via
 * GL_REPEAT — no blocks, no seams, no overlap blending needed. Intensity
 * is scaled by luminance using a piece-wise linear ramp.
 *
 * The grain template is generated on CPU (~5-15ms, on grain size change
 * only) and uploaded as an R8 texture (grain values [-1,1] encoded as
 * [0,255]). The fragment shader is a single texture lookup per channel.
 */
import { useEffect, useRef, useCallback } from "react";
import type { FilmGrainParams } from "../types/filmGrain";
import { generateGrainTemplate, GRAIN_TEXTURE_SIZE } from "../utils/grainTemplate";

// ── Shaders ──

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
"precision highp float;",
"",
"in vec2 v_texCoord;",
"uniform sampler2D u_video;",
"uniform sampler2D u_grain;",
"uniform float u_intensity;",
"uniform float u_grainSize;",
"uniform vec2 u_frameOffset;",
"uniform int u_blendMode;",
"uniform int u_chromatic;",
"uniform vec2 u_resolution;",
"",
"out vec4 fragColor;",
"",
"void main() {",
"  vec4 vid = texture(u_video, v_texCoord);",
"  vec2 px = v_texCoord * u_resolution;",
"  vec2 grainUV = px / u_grainSize + u_frameOffset;",
"",
"  float gR = texture(u_grain, grainUV).r * 2.0 - 1.0;",
"  float gG = gR;",
"  float gB = gR;",
"  if (u_chromatic == 1) {",
"    gG = texture(u_grain, grainUV + vec2(0.6180, 0.3819)).r * 2.0 - 1.0;",
"    gB = texture(u_grain, grainUV + vec2(0.3819, 0.7236)).r * 2.0 - 1.0;",
"  }",
"",
// Luminance-dependent intensity scaling (BT.601)
"  float luma = dot(vid.rgb, vec3(0.299, 0.587, 0.114));",
"  float sc = u_intensity;",
"  if (luma < 0.15) sc *= luma / 0.15;",
"  else if (luma > 0.85) sc *= (1.0 - luma) / 0.15;",
"",
"  vec3 g = vec3(gR, gG, gB) * sc;",
"  vec3 res;",
"  if (u_blendMode == 1) {",
"    res = vid.rgb * (1.0 + g);",
"  } else {",
"    res = vid.rgb + g;",
"  }",
"  fragColor = vec4(clamp(res, 0.0, 1.0), 1.0);",
"}",
].join("\n");

// ── GL state ──

interface GlState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texVideo: WebGLTexture;
  texGrain: WebGLTexture;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  uIntensity: WebGLUniformLocation | null;
  uGrainSize: WebGLUniformLocation | null;
  uFrameOffset: WebGLUniformLocation | null;
  uBlendMode: WebGLUniformLocation | null;
  uChromatic: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const label = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    const log = gl.getShaderInfoLog(sh);
    console.error(`Film grain ${label} shader compile error:`, log || "(driver returned no details)");
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function initGl(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: false,
    antialias: false,
  });
  if (!gl) {
    console.warn("useFilmGrainRenderer: WebGL2 not available");
    return null;
  }

  const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vert || !frag) {
    if (vert) gl.deleteShader(vert);
    if (frag) gl.deleteShader(frag);
    return null;
  }

  const program = gl.createProgram()!;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Film grain program link error:", gl.getProgramInfoLog(program) || "(no details)");
    gl.deleteProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return null;
  }

  gl.detachShader(program, vert);
  gl.detachShader(program, frag);
  gl.deleteShader(vert);
  gl.deleteShader(frag);

  // Fullscreen quad
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

  // Video texture
  const texVideo = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texVideo);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Grain template texture (R8, GL_REPEAT for seamless tiling)
  const texGrain = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texGrain);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  return {
    gl, program, texVideo, texGrain, vao, vbo,
    uIntensity: gl.getUniformLocation(program, "u_intensity"),
    uGrainSize: gl.getUniformLocation(program, "u_grainSize"),
    uFrameOffset: gl.getUniformLocation(program, "u_frameOffset"),
    uBlendMode: gl.getUniformLocation(program, "u_blendMode"),
    uChromatic: gl.getUniformLocation(program, "u_chromatic"),
    uResolution: gl.getUniformLocation(program, "u_resolution"),
  };
}

function destroyGl(state: GlState) {
  const { gl, program, texVideo, texGrain, vao, vbo } = state;
  gl.deleteTexture(texVideo);
  gl.deleteTexture(texGrain);
  gl.deleteVertexArray(vao);
  gl.deleteBuffer(vbo);
  gl.deleteProgram(program);
  // Do NOT call WEBGL_lose_context.loseContext() here — it permanently marks
  // the context as lost on this canvas. React StrictMode re-runs effects,
  // and getContext("webgl2") returns the same (now-lost) context, causing
  // init to fail on remount. Deleting GL objects is sufficient cleanup.
}

// ── Hook ──

interface UseFilmGrainRendererParams {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoEl: HTMLVideoElement | null;
  active: boolean;
  params: FilmGrainParams;
}

export function useFilmGrainRenderer({
  canvasRef,
  videoEl,
  active,
  params,
}: UseFilmGrainRendererParams) {
  const glStateRef = useRef<GlState | null>(null);
  const contextLostRef = useRef(false);
  const paramsRef = useRef(params);
  const activeRef = useRef(active);
  paramsRef.current = params;
  activeRef.current = active;

  // Track current template to avoid regenerating on every frame
  const currentTemplateKey = useRef("");

  const uploadTemplate = useCallback((state: GlState, grainParams: FilmGrainParams) => {
    const key = `${grainParams.size}`;
    if (key === currentTemplateKey.current) return;
    currentTemplateKey.current = key;

    const template = generateGrainTemplate(grainParams.size);
    const { gl, texGrain } = state;

    // Encode [-1,1] → [0,255] for R8 texture (shader decodes: val * 2.0 - 1.0)
    const r8 = new Uint8Array(template.length);
    for (let i = 0; i < template.length; i++) {
      r8[i] = Math.round((template[i] * 0.5 + 0.5) * 255);
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texGrain);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R8,
      GRAIN_TEXTURE_SIZE, GRAIN_TEXTURE_SIZE, 0,
      gl.RED, gl.UNSIGNED_BYTE, r8,
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active || !videoEl) return;

    let state = glStateRef.current;
    if (!state) {
      state = initGl(canvas);
      if (!state) return;
      glStateRef.current = state;

      const onLost = (e: Event) => {
        e.preventDefault();
        contextLostRef.current = true;
      };
      const onRestored = () => {
        contextLostRef.current = false;
        glStateRef.current = null;
        currentTemplateKey.current = "";
      };
      canvas.addEventListener("webglcontextlost", onLost);
      canvas.addEventListener("webglcontextrestored", onRestored);
    }

    // Upload initial template
    uploadTemplate(state, params);

    const { gl, program, texVideo, vao, uIntensity, uGrainSize, uFrameOffset, uBlendMode, uChromatic, uResolution } = state;

    let rafId: number;

    const render = () => {
      if (contextLostRef.current || !activeRef.current || !videoEl) return;

      const p = paramsRef.current;
      const dpr = window.devicePixelRatio || 1;

      const containerW = canvas.clientWidth;
      const containerH = canvas.clientHeight;
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;

      const canvasW = Math.round(containerW * dpr);
      const canvasH = Math.round(containerH * dpr);
      if (canvasW === 0 || canvasH === 0) {
        rafId = requestAnimationFrame(render);
        return;
      }
      if (canvas.width !== canvasW || canvas.height !== canvasH) {
        canvas.width = canvasW;
        canvas.height = canvasH;
      }

      // Letterbox viewport
      let vpX = 0, vpY = 0, vpW = canvasW, vpH = canvasH;
      if (vw > 0 && vh > 0) {
        const videoAspect = vw / vh;
        const canvasAspect = canvasW / canvasH;
        if (videoAspect > canvasAspect) {
          vpH = Math.round(canvasW / videoAspect);
          vpY = Math.round((canvasH - vpH) / 2);
        } else if (videoAspect < canvasAspect) {
          vpW = Math.round(canvasH * videoAspect);
          vpX = Math.round((canvasW - vpW) / 2);
        }
      }

      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(vpX, vpY, vpW, vpH);

      // Upload video frame
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texVideo);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);
      } catch {
        rafId = requestAnimationFrame(render);
        return;
      }

      // Re-upload template if size changed
      uploadTemplate(glStateRef.current!, p);

      // Set uniforms
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, "u_video"), 0);
      gl.uniform1i(gl.getUniformLocation(program, "u_grain"), 1);
      gl.uniform1f(uIntensity, (p.intensity / 100) * 0.15);
      gl.uniform1f(uGrainSize, GRAIN_TEXTURE_SIZE);
      // Irrational multipliers prevent periodic aliasing; stable when paused
      const t = videoEl.currentTime;
      gl.uniform2f(uFrameOffset, fract(t * 1.7321), fract(t * 2.2360));
      gl.uniform1i(uBlendMode, p.blendMode === "multiplicative" ? 1 : 0);
      gl.uniform1i(uChromatic, p.chromatic ? 1 : 0);
      gl.uniform2f(uResolution, vpW, vpH);

      // Bind grain texture
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, glStateRef.current!.texGrain);

      // Draw
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);

      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [active, videoEl, canvasRef, params, uploadTemplate]);

  // Destroy GL on unmount
  useEffect(() => {
    return () => {
      if (glStateRef.current) {
        destroyGl(glStateRef.current);
        glStateRef.current = null;
        currentTemplateKey.current = "";
      }
    };
  }, []);
}

function fract(x: number): number {
  return x - Math.floor(x);
}

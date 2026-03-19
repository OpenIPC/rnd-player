/**
 * useProResRenderer — WebGL2 YUV 4:2:2/4:4:4 10-bit → RGB renderer.
 *
 * Uses R16UI integer textures with texelFetch for precise 10-bit sample access.
 * BT.709 studio-range YCbCr → RGB conversion in the fragment shader.
 *
 * Follows the useDiffRenderer pattern: fullscreen quad, letterboxed viewport,
 * lazy GL init/destroy.
 */

import { useEffect, useRef, useCallback } from "react";
import type { DecodedFrame } from "../types/proResWorker.types";

const VERT_SRC = `#version 300 es
in vec2 a_position;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = vec2(a_position.x * 0.5 + 0.5, 1.0 - (a_position.y * 0.5 + 0.5));
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp usampler2D;

in vec2 v_texCoord;
uniform usampler2D u_texY;
uniform usampler2D u_texCb;
uniform usampler2D u_texCr;
uniform ivec2 u_ySize;
uniform ivec2 u_cSize;
out vec4 fragColor;

void main() {
  ivec2 yPos = ivec2(v_texCoord * vec2(u_ySize));
  ivec2 cPos = ivec2(v_texCoord * vec2(u_cSize));

  float y  = float(texelFetch(u_texY,  clamp(yPos, ivec2(0), u_ySize - 1), 0).r) / 1023.0;
  float cb = float(texelFetch(u_texCb, clamp(cPos, ivec2(0), u_cSize - 1), 0).r) / 1023.0;
  float cr = float(texelFetch(u_texCr, clamp(cPos, ivec2(0), u_cSize - 1), 0).r) / 1023.0;

  // BT.709 studio range to RGB
  float yN  = (y  - 16.0/255.0) / (219.0/255.0);
  float cbN = (cb - 128.0/255.0) / (224.0/255.0);
  float crN = (cr - 128.0/255.0) / (224.0/255.0);

  vec3 rgb = vec3(
    yN + 1.5748 * crN,
    yN - 0.1873 * cbN - 0.4681 * crN,
    yN + 1.8556 * cbN
  );
  fragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

interface GlState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  texY: WebGLTexture;
  texCb: WebGLTexture;
  texCr: WebGLTexture;
  uTexY: WebGLUniformLocation;
  uTexCb: WebGLUniformLocation;
  uTexCr: WebGLUniformLocation;
  uYSize: WebGLUniformLocation;
  uCSize: WebGLUniformLocation;
  lastYW: number;
  lastYH: number;
  lastCW: number;
  lastCH: number;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

function createIntTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Integer textures require NEAREST filtering
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function initGl(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
  if (!gl) return null;

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);

  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  // Fullscreen quad (two triangles)
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // prettier-ignore
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const texY = createIntTexture(gl);
  const texCb = createIntTexture(gl);
  const texCr = createIntTexture(gl);

  return {
    gl,
    program,
    vao,
    texY,
    texCb,
    texCr,
    uTexY: gl.getUniformLocation(program, "u_texY")!,
    uTexCb: gl.getUniformLocation(program, "u_texCb")!,
    uTexCr: gl.getUniformLocation(program, "u_texCr")!,
    uYSize: gl.getUniformLocation(program, "u_ySize")!,
    uCSize: gl.getUniformLocation(program, "u_cSize")!,
    lastYW: 0,
    lastYH: 0,
    lastCW: 0,
    lastCH: 0,
  };
}

function uploadPlane(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  unit: number,
  data: Uint16Array,
  width: number,
  height: number,
  prevW: number,
  prevH: number,
): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (width !== prevW || height !== prevH) {
    // Reallocate texture
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16UI,
      width,
      height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      data,
    );
  } else {
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width,
      height,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      data,
    );
  }
}

export interface ProResRendererHandle {
  renderFrame: (frame: DecodedFrame) => void;
}

export function useProResRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
): ProResRendererHandle {
  const stateRef = useRef<GlState | null>(null);

  // Initialize GL on mount / destroy on unmount
  useEffect(() => {
    return () => {
      const s = stateRef.current;
      if (s) {
        s.gl.deleteTexture(s.texY);
        s.gl.deleteTexture(s.texCb);
        s.gl.deleteTexture(s.texCr);
        s.gl.deleteProgram(s.program);
        s.gl.deleteVertexArray(s.vao);
        stateRef.current = null;
      }
    };
  }, []);

  const renderFrame = useCallback(
    (frame: DecodedFrame) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Lazy init
      if (!stateRef.current) {
        stateRef.current = initGl(canvas);
        if (!stateRef.current) return;
      }

      const s = stateRef.current;
      const { gl } = s;

      // Resize canvas to match CSS layout * DPR
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w === 0 || h === 0) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      // Upload Y plane
      uploadPlane(gl, s.texY, 0, frame.yPlane, frame.width, frame.height, s.lastYW, s.lastYH);
      s.lastYW = frame.width;
      s.lastYH = frame.height;

      // Upload Cb plane
      uploadPlane(
        gl,
        s.texCb,
        1,
        frame.cbPlane,
        frame.chromaWidth,
        frame.chromaHeight,
        s.lastCW,
        s.lastCH,
      );

      // Upload Cr plane
      uploadPlane(
        gl,
        s.texCr,
        2,
        frame.crPlane,
        frame.chromaWidth,
        frame.chromaHeight,
        s.lastCW,
        s.lastCH,
      );
      s.lastCW = frame.chromaWidth;
      s.lastCH = frame.chromaHeight;

      // Compute letterboxed viewport
      const videoAspect = frame.width / frame.height;
      const canvasAspect = canvas.width / canvas.height;
      let vpX = 0,
        vpY = 0,
        vpW = canvas.width,
        vpH = canvas.height;
      if (videoAspect > canvasAspect) {
        vpH = Math.round(canvas.width / videoAspect);
        vpY = Math.round((canvas.height - vpH) / 2);
      } else if (videoAspect < canvasAspect) {
        vpW = Math.round(canvas.height * videoAspect);
        vpX = Math.round((canvas.width - vpW) / 2);
      }

      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(vpX, vpY, vpW, vpH);

      gl.useProgram(s.program);
      gl.uniform1i(s.uTexY, 0);
      gl.uniform1i(s.uTexCb, 1);
      gl.uniform1i(s.uTexCr, 2);
      gl.uniform2i(s.uYSize, frame.width, frame.height);
      gl.uniform2i(s.uCSize, frame.chromaWidth, frame.chromaHeight);

      gl.bindVertexArray(s.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    },
    [canvasRef],
  );

  return { renderFrame };
}

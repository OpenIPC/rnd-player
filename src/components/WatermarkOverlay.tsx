import { useEffect, useRef } from "react";
import type { WatermarkToken } from "../drm/types";
import "./WatermarkOverlay.css";

interface WatermarkOverlayProps {
  videoEl: HTMLVideoElement;
  watermark: WatermarkToken;
}

/** Compute the video's rendered area within its container, accounting for object-fit: contain letterboxing. */
function getVideoRect(videoEl: HTMLVideoElement): {
  x: number; y: number; width: number; height: number;
} {
  const containerW = videoEl.clientWidth;
  const containerH = videoEl.clientHeight;
  const videoW = videoEl.videoWidth;
  const videoH = videoEl.videoHeight;

  if (!videoW || !videoH || !containerW || !containerH) {
    return { x: 0, y: 0, width: containerW, height: containerH };
  }

  const scale = Math.min(containerW / videoW, containerH / videoH);
  const renderedW = videoW * scale;
  const renderedH = videoH * scale;
  const x = (containerW - renderedW) / 2;
  const y = (containerH - renderedH) / 2;

  return { x, y, width: renderedW, height: renderedH };
}

/** Mulberry32 seeded PRNG — returns a function that produces [0, 1) floats. */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface WatermarkPosition {
  x: number;
  y: number;
  angle: number;
}

function getWatermarkPositions(
  seed: number,
  width: number,
  height: number,
): WatermarkPosition[] {
  const rng = mulberry32(seed);
  const positions: WatermarkPosition[] = [];
  for (let i = 0; i < 5; i++) {
    positions.push({
      x: width * (0.1 + rng() * 0.8),
      y: height * (0.1 + rng() * 0.8),
      angle: (rng() * 30 - 15) * (Math.PI / 180), // -15° to +15°
    });
  }
  return positions;
}

export default function WatermarkOverlay({ videoEl, watermark }: WatermarkOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const containerW = videoEl.clientWidth;
      const containerH = videoEl.clientHeight;

      canvas.width = containerW * dpr;
      canvas.height = containerH * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, containerW, containerH);

      const { x, y, width, height } = getVideoRect(videoEl);
      if (width <= 0 || height <= 0) return;

      const seed = Math.floor(Date.now() / 30_000);
      const positions = getWatermarkPositions(seed, width, height);

      ctx.font = "14px monospace";
      ctx.fillStyle = `rgba(255, 255, 255, ${watermark.opacity})`;
      ctx.globalCompositeOperation = "lighter";
      ctx.textBaseline = "middle";

      for (const pos of positions) {
        ctx.save();
        ctx.translate(x + pos.x, y + pos.y);
        ctx.rotate(pos.angle);
        ctx.fillText(watermark.session_short, 0, 0);
        ctx.restore();
      }
    };

    draw();

    // Reposition every 30 seconds
    const interval = setInterval(draw, 30_000);

    // Redraw on resize (fullscreen transitions, etc.)
    const observer = new ResizeObserver(draw);
    observer.observe(videoEl);

    return () => {
      clearInterval(interval);
      observer.disconnect();
    };
  }, [videoEl, watermark]);

  return (
    <canvas
      ref={canvasRef}
      className="vp-watermark-canvas"
    />
  );
}

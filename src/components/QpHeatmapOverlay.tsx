import { useEffect, useRef } from "react";
import type { QpHeatmapData } from "../hooks/useQpHeatmap";

interface QpHeatmapOverlayProps {
  videoEl: HTMLVideoElement;
  data: QpHeatmapData;
}

/**
 * 5-stop color gradient: blue → cyan → green → yellow → red
 * Low QP = blue (high quality), High QP = red (low quality).
 */
function qpToColor(qp: number, minQp: number, maxQp: number): [number, number, number] {
  const range = maxQp - minQp;
  const t = range > 0 ? (qp - minQp) / range : 0.5;

  // 5 stops: 0=blue, 0.25=cyan, 0.5=green, 0.75=yellow, 1.0=red
  let r: number, g: number, b: number;
  if (t < 0.25) {
    const s = t / 0.25;
    r = 0; g = Math.round(255 * s); b = 255;
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    r = 0; g = 255; b = Math.round(255 * (1 - s));
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    r = Math.round(255 * s); g = 255; b = 0;
  } else {
    const s = (t - 0.75) / 0.25;
    r = 255; g = Math.round(255 * (1 - s)); b = 0;
  }

  return [r, g, b];
}

/**
 * Compute the video's rendered area within its container,
 * accounting for object-fit: contain letterboxing.
 */
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

export default function QpHeatmapOverlay({ videoEl, data }: QpHeatmapOverlayProps) {
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
      const { qpValues, widthMbs, heightMbs, minQp, maxQp } = data;

      const mbW = width / widthMbs;
      const mbH = height / heightMbs;

      // Draw QP heatmap
      ctx.globalAlpha = 0.5;
      for (let row = 0; row < heightMbs; row++) {
        for (let col = 0; col < widthMbs; col++) {
          const idx = row * widthMbs + col;
          if (idx >= qpValues.length) continue;
          const qp = qpValues[idx];
          const [r, g, b] = qpToColor(qp, minQp, maxQp);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x + col * mbW, y + row * mbH, Math.ceil(mbW), Math.ceil(mbH));
        }
      }

      // Draw legend in bottom-right corner
      ctx.globalAlpha = 1;
      const legendW = 120;
      const legendH = 44;
      const legendX = x + width - legendW - 8;
      const legendY = y + height - legendH - 8;

      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.beginPath();
      ctx.roundRect(legendX, legendY, legendW, legendH, 4);
      ctx.fill();

      // Color bar
      const barX = legendX + 8;
      const barY = legendY + 6;
      const barW = legendW - 16;
      const barH = 10;
      const gradient = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      gradient.addColorStop(0, "rgb(0,0,255)");
      gradient.addColorStop(0.25, "rgb(0,255,255)");
      gradient.addColorStop(0.5, "rgb(0,255,0)");
      gradient.addColorStop(0.75, "rgb(255,255,0)");
      gradient.addColorStop(1, "rgb(255,0,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(barX, barY, barW, barH);

      // QP range labels
      ctx.fillStyle = "#fff";
      ctx.font = "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(`QP ${minQp}`, barX, barY + barH + 4);
      ctx.textAlign = "right";
      ctx.fillText(`${maxQp}`, barX + barW, barY + barH + 4);
    };

    draw();

    // Redraw on resize (fullscreen transitions, etc.)
    const observer = new ResizeObserver(draw);
    observer.observe(videoEl);
    return () => observer.disconnect();
  }, [videoEl, data]);

  return (
    <canvas
      ref={canvasRef}
      className="vp-qp-heatmap-canvas"
    />
  );
}

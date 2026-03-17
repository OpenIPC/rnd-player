import { useRef } from "react";
import { useFilmGrainRenderer } from "../hooks/useFilmGrainRenderer";
import type { FilmGrainParams } from "../types/filmGrain";
import "./FilmGrainOverlay.css";

interface FilmGrainOverlayProps {
  videoEl: HTMLVideoElement;
  params: FilmGrainParams;
}

export default function FilmGrainOverlay({ videoEl, params }: FilmGrainOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useFilmGrainRenderer({
    canvasRef,
    videoEl,
    active: true,
    params,
  });

  return (
    <canvas
      ref={canvasRef}
      className="vp-film-grain-canvas"
    />
  );
}

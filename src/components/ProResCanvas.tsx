/**
 * ProResCanvas — WebGL2 canvas that renders decoded YUV 10-bit frames.
 *
 * Receives decoded frames from the playback hook and renders them via
 * useProResRenderer's WebGL2 pipeline. The canvas fills its parent
 * container with letterboxing to maintain aspect ratio.
 */

import { useEffect, useRef } from "react";
import { useProResRenderer } from "../hooks/useProResRenderer";
import type { DecodedFrame } from "../types/proResWorker.types";

interface ProResCanvasProps {
  frame: DecodedFrame | null;
  className?: string;
}

export default function ProResCanvas({ frame, className }: ProResCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { renderFrame } = useProResRenderer(canvasRef);

  useEffect(() => {
    if (frame) {
      renderFrame(frame);
    }
  }, [frame, renderFrame]);

  return (
    <canvas
      ref={canvasRef}
      className={className ?? "vp-prores-canvas"}
      style={{ width: "100%", height: "100%", display: "block", background: "#000" }}
    />
  );
}

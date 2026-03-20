/**
 * ProResCanvas — WebGL2 canvas for ProRes YUV 10-bit rendering.
 *
 * Exposes a renderFrame function via ref. Frame data is passed directly
 * (via ref callback) to avoid pushing 8+ MB typed arrays through React state.
 */

import { forwardRef, useImperativeHandle, useRef } from "react";
import { useProResRenderer } from "../hooks/useProResRenderer";
import type { DecodedFrame } from "../types/proResWorker.types";

export interface ProResCanvasHandle {
  renderFrame: (frame: DecodedFrame) => void;
}

const ProResCanvas = forwardRef<ProResCanvasHandle, { className?: string }>(
  function ProResCanvas({ className }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const { renderFrame } = useProResRenderer(canvasRef);

    useImperativeHandle(ref, () => ({ renderFrame }), [renderFrame]);

    return (
      <canvas
        ref={canvasRef}
        className={className ?? "vp-prores-canvas"}
        style={{ width: "100%", height: "100%", display: "block", background: "#000" }}
      />
    );
  },
);

export default ProResCanvas;

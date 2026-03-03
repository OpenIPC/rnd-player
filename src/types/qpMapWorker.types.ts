/** Messages sent TO the QP map worker. */
export interface QpMapDecodeRequest {
  type: "decode";
  initSegment: ArrayBuffer;
  mediaSegment: ArrayBuffer;
  /** Target presentation time in seconds to find the frame. */
  targetTime: number;
  /** Video width in pixels (for validation). */
  width: number;
  /** Video height in pixels (for validation). */
  height: number;
}

export type QpMapWorkerRequest = QpMapDecodeRequest;

/** Messages sent FROM the QP map worker. */
export interface QpMapResult {
  type: "qpMap";
  /** Flat array of luma QP values, one per macroblock, in raster order. */
  qpValues: Uint8Array;
  /** Width in macroblocks. */
  widthMbs: number;
  /** Height in macroblocks. */
  heightMbs: number;
  /** Minimum QP in this frame. */
  minQp: number;
  /** Maximum QP in this frame. */
  maxQp: number;
}

export interface QpMapError {
  type: "error";
  message: string;
}

export type QpMapWorkerResponse = QpMapResult | QpMapError;

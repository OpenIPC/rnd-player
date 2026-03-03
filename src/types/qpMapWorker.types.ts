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
  /** Codec type: h264 uses JM decoder, h265 uses HM decoder. */
  codec: "h264" | "h265";
}

export type QpMapWorkerRequest = QpMapDecodeRequest;

/** Messages sent FROM the QP map worker. */
export interface QpMapResult {
  type: "qpMap";
  /** Flat array of luma QP values, one per block, in raster order. */
  qpValues: Uint8Array;
  /** Width in blocks (16px for H.264 macroblocks, 8px for H.265 CU grid). */
  widthMbs: number;
  /** Height in blocks (16px for H.264 macroblocks, 8px for H.265 CU grid). */
  heightMbs: number;
  /** Block size in pixels (16 for H.264, 8 for H.265). */
  blockSize: number;
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

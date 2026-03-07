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
  /** Codec type: h264 uses JM decoder, h265 uses HM decoder, av1 uses dav1d decoder. */
  codec: "h264" | "h265" | "av1";
  /** ClearKey hex string for CENC decryption (32 hex chars). */
  clearKeyHex?: string;
}

/** Decode all frames in a segment and return per-frame QP maps. */
export interface QpMapDecodeSegmentRequest {
  type: "decodeSegmentQp";
  initSegment: ArrayBuffer;
  mediaSegment: ArrayBuffer;
  codec: "h264" | "h265" | "av1";
  clearKeyHex?: string;
}

export type QpMapWorkerRequest = QpMapDecodeRequest | QpMapDecodeSegmentRequest;

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

/** Per-frame QP data for segment decode. */
export interface PerFrameQp {
  qpValues: Uint8Array;
  avgQp: number;
  minQp: number;
  maxQp: number;
}

/** Result of decodeSegmentQp — per-frame QP maps for all frames in the segment. */
export interface QpMapSegmentResult {
  type: "qpSegment";
  frames: PerFrameQp[];
  /** Block grid dimensions (same for all frames in a segment). */
  widthMbs: number;
  heightMbs: number;
  blockSize: number;
  /** Global min/max across all frames (for consistent color scale). */
  globalMinQp: number;
  globalMaxQp: number;
}

export interface QpMapError {
  type: "error";
  message: string;
}

export type QpMapWorkerResponse = QpMapResult | QpMapSegmentResult | QpMapError;

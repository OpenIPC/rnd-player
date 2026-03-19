/** Messages sent TO the ProRes decode worker. */
export interface ProResWorkerInit {
  type: "init";
  /** Full URL to the MOV file (used for Range requests). */
  url: string;
  /** Parsed sample table entries. */
  sampleTable: SampleTableEntry[];
  /** ProRes FourCC variant (e.g. "apch", "apcn"). */
  fourcc: string;
  /** True for 4:4:4 variants (ap4h/ap4x). */
  is444: boolean;
  /** Video width. */
  width: number;
  /** Video height. */
  height: number;
}

export interface ProResWorkerDecodeFrame {
  type: "decodeFrame";
  /** Monotonic request ID for cancellation and stale-response filtering. */
  requestId: number;
  /** Zero-based frame index into the sample table. */
  frameIndex: number;
}

export interface ProResWorkerCancel {
  type: "cancel";
  requestId: number;
}

export type ProResWorkerRequest =
  | ProResWorkerInit
  | ProResWorkerDecodeFrame
  | ProResWorkerCancel;

/** A single entry from the MOV sample table. */
export interface SampleTableEntry {
  /** Byte offset in the file. */
  offset: number;
  /** Byte size of the compressed frame. */
  size: number;
  /** Sample duration in timescale units. */
  duration: number;
}

/** Decoded YUV frame transferred back to the main thread. */
export interface DecodedFrame {
  width: number;
  height: number;
  /** Chroma plane width (width/2 for 4:2:2, width for 4:4:4). */
  chromaWidth: number;
  /** Chroma plane height. */
  chromaHeight: number;
  yPlane: Uint16Array;
  cbPlane: Uint16Array;
  crPlane: Uint16Array;
  alphaPlane?: Uint16Array;
}

/** Messages sent FROM the ProRes decode worker. */
export interface ProResWorkerReady {
  type: "ready";
}

export interface ProResWorkerFrame {
  type: "frame";
  requestId: number;
  frameIndex: number;
  frame: DecodedFrame;
}

export interface ProResWorkerError {
  type: "error";
  requestId: number;
  message: string;
}

export type ProResWorkerResponse =
  | ProResWorkerReady
  | ProResWorkerFrame
  | ProResWorkerError;

/** ProRes codec FourCC variants. */
export type ProResFourCC = "apch" | "apcn" | "apcs" | "apco" | "ap4h" | "ap4x";

/** Metadata extracted from moov atom for ProRes tracks. */
export interface ProResTrackInfo {
  fourcc: ProResFourCC;
  profileName: string;
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  timescale: number;
  duration: number;
  bitDepth: number;
  chroma: "4:2:2" | "4:4:4";
  sampleTable: SampleTableEntry[];
}

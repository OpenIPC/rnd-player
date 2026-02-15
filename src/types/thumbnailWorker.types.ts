export type FrameType = "I" | "P" | "B";

export interface GopFrame {
  type: FrameType;
  size: number;
}

/** Messages from main thread to thumbnail worker */
export type WorkerRequest =
  | {
      type: "generate";
      initSegmentUrl: string;
      segments: { url: string; startTime: number; endTime: number }[];
      codec: string;
      width: number;
      height: number;
      thumbnailWidth: number;
      clearKeyHex?: string;
      /** Active (watched) stream info for frame type classification */
      activeInitSegmentUrl?: string;
      activeSegments?: { url: string; startTime: number; endTime: number }[];
    }
  | { type: "updateQueue"; segmentIndices: number[] }
  | {
      type: "saveFrame";
      time: number;
      initSegmentUrl: string;
      segments: { url: string; startTime: number; endTime: number }[];
      codec: string;
      width: number;
      height: number;
    }
  | { type: "updateIntraQueue"; items: { segmentIndex: number; count: number }[] }
  | { type: "requestGop"; segmentIndex: number }
  | { type: "abort" };

/** Messages from thumbnail worker to main thread */
export type WorkerResponse =
  | { type: "thumbnail"; timestamp: number; bitmap: ImageBitmap }
  | { type: "error"; message: string }
  | { type: "ready" }
  | { type: "saveFrameResult"; bitmap: ImageBitmap | null }
  | { type: "intraFrames"; segmentIndex: number; bitmaps: ImageBitmap[]; frameTypes: FrameType[]; gopStructure: GopFrame[] }
  | { type: "gopStructure"; segmentIndex: number; gopStructure: GopFrame[] };

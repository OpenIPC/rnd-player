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
  | { type: "abort" };

/** Messages from thumbnail worker to main thread */
export type WorkerResponse =
  | { type: "thumbnail"; timestamp: number; bitmap: ImageBitmap }
  | { type: "error"; message: string }
  | { type: "ready" }
  | { type: "saveFrameResult"; bitmap: ImageBitmap | null };

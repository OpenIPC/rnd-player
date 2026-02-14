export type ExportWorkerRequest =
  | {
      type: "export";
      initSegmentUrl: string;
      segments: { url: string; startTime: number; endTime: number }[];
      clearKeyHex?: string;
    }
  | { type: "abort" };

export type ExportWorkerResponse =
  | { type: "progress"; loaded: number; total: number }
  | { type: "done"; data: ArrayBuffer }
  | { type: "error"; message: string };

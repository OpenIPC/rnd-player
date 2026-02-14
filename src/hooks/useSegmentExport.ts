import { useRef, useState, useCallback } from "react";
import type shaka from "shaka-player";
import type {
  ExportWorkerRequest,
  ExportWorkerResponse,
} from "../types/segmentExportWorker.types";
import { extractInitSegmentUrl } from "../utils/extractInitSegmentUrl";

export interface ExportRendition {
  width: number;
  height: number;
  videoCodec: string;
  bandwidth: number;
}

export interface SegmentExportResult {
  startExport: (rendition: ExportRendition) => void;
  exporting: boolean;
  progress: { loaded: number; total: number } | null;
  cancel: () => void;
}

export function useSegmentExport(
  player: shaka.Player | null,
  inPoint: number | null,
  outPoint: number | null,
  clearKey?: string,
): SegmentExportResult {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const cancel = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "abort" } satisfies ExportWorkerRequest);
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setExporting(false);
    setProgress(null);
  }, []);

  const startExport = useCallback(
    (rendition: ExportRendition) => {
      if (!player || inPoint == null || outPoint == null || inPoint >= outPoint) return;

      const manifest = player.getManifest();
      if (!manifest?.variants?.length) return;

      // Find matching variant by width/height/codec
      let matchedStream: shaka.extern.Stream | null = null;
      for (const v of manifest.variants) {
        if (
          v.video &&
          v.video.width === rendition.width &&
          v.video.height === rendition.height &&
          v.video.codecs === rendition.videoCodec
        ) {
          matchedStream = v.video;
          break;
        }
      }
      if (!matchedStream) return;

      // Async segment index creation + worker spawn
      (async () => {
        await matchedStream!.createSegmentIndex();
        const segmentIndex = matchedStream!.segmentIndex;
        if (!segmentIndex) return;

        const iter = segmentIndex[Symbol.iterator]();
        const firstResult = iter.next();
        if (firstResult.done) return;
        const firstRef = firstResult.value;
        if (!firstRef) return;

        const initSegmentUrl = extractInitSegmentUrl(firstRef);
        if (!initSegmentUrl) return;

        // Collect segments overlapping [inPoint, outPoint]
        const segments: { url: string; startTime: number; endTime: number }[] = [];
        for (const ref of segmentIndex) {
          if (!ref) continue;
          const uris = ref.getUris();
          if (uris.length === 0) continue;
          const startTime = ref.getStartTime();
          const endTime = ref.getEndTime();
          if (startTime < outPoint && endTime > inPoint) {
            segments.push({ url: uris[0], startTime, endTime });
          }
        }
        if (segments.length === 0) return;

        // Determine if stream is encrypted
        const streamEncrypted = !!(
          matchedStream!.encrypted ||
          (matchedStream!.drmInfos && matchedStream!.drmInfos.length > 0)
        );

        // Spawn worker
        const worker = new Worker(
          new URL("../workers/segmentExportWorker.ts", import.meta.url),
          { type: "module" },
        );
        workerRef.current = worker;
        setExporting(true);
        setProgress({ loaded: 0, total: segments.length });

        worker.onmessage = (e: MessageEvent<ExportWorkerResponse>) => {
          const msg = e.data;
          switch (msg.type) {
            case "progress":
              setProgress({ loaded: msg.loaded, total: msg.total });
              break;
            case "done": {
              // Build filename
              const uri = player.getAssetUri?.() ?? "";
              const slug = decodeURIComponent(
                uri.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "",
              )
                .replace(/[^a-zA-Z0-9_-]+/g, "_")
                .replace(/^_+|_+$/g, "");
              const title = slug || "segment";

              const fmtTime = (t: number) => {
                const hh = Math.floor(t / 3600);
                const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
                const ss = String(Math.floor(t % 60)).padStart(2, "0");
                return hh > 0 ? `${hh}-${mm}-${ss}` : `${mm}-${ss}`;
              };

              const filename = `${title}_${fmtTime(inPoint)}-${fmtTime(outPoint)}_${rendition.height}p.mp4`;

              const blob = new Blob([msg.data], { type: "video/mp4" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = filename;
              a.click();
              URL.revokeObjectURL(url);

              worker.terminate();
              workerRef.current = null;
              setExporting(false);
              setProgress(null);
              break;
            }
            case "error":
              console.error("Segment export error:", msg.message);
              worker.terminate();
              workerRef.current = null;
              setExporting(false);
              setProgress(null);
              break;
          }
        };

        worker.postMessage({
          type: "export",
          initSegmentUrl,
          segments,
          clearKeyHex: streamEncrypted ? clearKey : undefined,
        } satisfies ExportWorkerRequest);
      })().catch((err) => {
        console.error("Segment export failed:", err);
        setExporting(false);
        setProgress(null);
      });
    },
    [player, inPoint, outPoint, clearKey],
  );

  return { startExport, exporting, progress, cancel };
}

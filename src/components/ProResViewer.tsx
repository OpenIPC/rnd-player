/**
 * ProResViewer — Top-level component for ProRes MOV playback.
 *
 * Probes the MOV URL via Range requests, parses the moov atom for ProRes
 * track info, initializes the decode worker pool, and coordinates
 * rendering + controls.
 */

import { useState, useEffect, useCallback } from "react";
import { probeMovUrl } from "../utils/proResProbe";
import type { ProResTrackInfo } from "../types/proResWorker.types";
import { useProResPlayback } from "../hooks/useProResPlayback";
import ProResCanvas from "./ProResCanvas";
import ProResControls from "./ProResControls";
import "./ProResViewer.css";

interface ProResViewerProps {
  src: string;
}

type ViewerState =
  | { status: "probing" }
  | { status: "error"; message: string }
  | { status: "ready"; trackInfo: ProResTrackInfo; fileSize: number };

export default function ProResViewer({ src }: ProResViewerProps) {
  const [viewerState, setViewerState] = useState<ViewerState>({
    status: "probing",
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const result = await probeMovUrl(src);
        if (cancelled) return;

        if (result.tracks.length === 0) {
          setViewerState({
            status: "error",
            message: "No ProRes video track found in this MOV file.",
          });
          return;
        }

        // Use the first ProRes video track
        const track = result.tracks[0];
        setViewerState({
          status: "ready",
          trackInfo: track,
          fileSize: result.fileSize,
        });
      } catch (e) {
        if (cancelled) return;
        setViewerState({
          status: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src]);

  if (viewerState.status === "probing") {
    return (
      <div className="vp-prores-container">
        <div className="vp-prores-loading">
          Probing MOV file...
        </div>
      </div>
    );
  }

  if (viewerState.status === "error") {
    return (
      <div className="vp-prores-container">
        <div className="vp-prores-error">
          <div className="vp-prores-error-title">ProRes Viewer Error</div>
          <div className="vp-prores-error-msg">{viewerState.message}</div>
        </div>
      </div>
    );
  }

  return (
    <ProResViewerReady
      src={src}
      trackInfo={viewerState.trackInfo}
    />
  );
}

function ProResViewerReady({
  src,
  trackInfo,
}: {
  src: string;
  trackInfo: ProResTrackInfo;
}) {
  const playback = useProResPlayback(
    trackInfo.sampleTable,
    src,
    trackInfo.fps,
    trackInfo.fourcc,
    trackInfo.chroma === "4:4:4",
    trackInfo.width,
    trackInfo.height,
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case " ":
          e.preventDefault();
          playback.togglePlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          playback.stepForward();
          break;
        case "ArrowLeft":
          e.preventDefault();
          playback.stepBackward();
          break;
      }
    },
    [playback],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="vp-prores-container">
      <div className="vp-prores-video-area">
        <ProResCanvas frame={playback.currentFrame} />
      </div>
      <ProResControls
        state={playback.state}
        handle={playback}
        trackInfo={trackInfo}
      />
    </div>
  );
}

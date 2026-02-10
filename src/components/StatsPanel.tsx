import { useEffect, useState, useRef } from "react";
import shaka from "shaka-player";

interface StatsPanelProps {
  player: shaka.Player;
  videoEl: HTMLVideoElement;
  onClose: () => void;
}

interface StatsData {
  // Row 1: Manifest
  assetUri: string;
  manifestType: string;
  // Row 2: Viewport / Frames
  viewport: string;
  droppedFrames: number;
  decodedFrames: number;
  // Row 3: Current / Optimal Res
  currentRes: string;
  optimalRes: string;
  // Row 4: Volume / Normalized
  volumePct: number;
  muted: boolean;
  // Row 5: Codecs
  videoCodec: string;
  audioCodec: string;
  videoId: string;
  audioId: string;
  // Row 6: Color
  colorGamut: string | null;
  hdr: string | null;
  // Row 7: Connection Speed
  estimatedBandwidthKbps: number;
  // Row 8: Network Activity
  networkActivityKBps: number;
  // Row 9: Buffer Health
  bufferHealthSec: number;
  // Row 10: Mystery Text
  streamBandwidth: number;
  loadLatency: number;
  gapsJumped: number;
  stallsDetected: number;
  manifestSizeBytes: number;
  // Row 11: Date
  date: string;
}

function formatTrackRes(
  width: number | null,
  height: number | null,
  frameRate: number | null
): string {
  if (width == null || height == null) return "N/A";
  const fps = frameRate ? `@${Math.round(frameRate)}` : "";
  return `${width}×${height}${fps}`;
}

function StatsBar({
  value,
  max,
}: {
  value: number;
  max: number;
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="vp-stats-bar-track">
      <div className="vp-stats-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function StatsPanel({
  player,
  videoEl,
  onClose,
}: StatsPanelProps) {
  const [data, setData] = useState<StatsData | null>(null);
  const prevBytesRef = useRef<number | null>(null);

  useEffect(() => {
    function collect(): StatsData {
      const stats = player.getStats();
      const buffered = player.getBufferedInfo();
      const tracks = player.getVariantTracks();
      const active = tracks.find((t) => t.active);

      // Optimal = highest resolution track
      const optimal = [...tracks].sort(
        (a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0)
      )[0];

      // Buffer health
      const totalBuf = buffered.total;
      const lastRange = totalBuf.length > 0 ? totalBuf[totalBuf.length - 1] : null;
      const bufferHealth = lastRange
        ? Math.max(0, lastRange.end - videoEl.currentTime)
        : 0;

      // Network activity delta
      const prevBytes = prevBytesRef.current;
      const networkDelta =
        prevBytes !== null ? stats.bytesDownloaded - prevBytes : 0;
      prevBytesRef.current = stats.bytesDownloaded;

      // Asset URI (truncated)
      const uri = player.getAssetUri() ?? "";
      const truncatedUri =
        uri.length > 60 ? uri.slice(0, 28) + "…" + uri.slice(-28) : uri;

      const dpr = window.devicePixelRatio || 1;

      return {
        assetUri: truncatedUri,
        manifestType: player.getManifestType() ?? "",
        viewport: `${Math.round(videoEl.clientWidth * dpr)}×${Math.round(videoEl.clientHeight * dpr)}`,
        droppedFrames: stats.droppedFrames,
        decodedFrames: stats.decodedFrames,
        currentRes: active
          ? formatTrackRes(active.width, active.height, active.frameRate)
          : "N/A",
        optimalRes: optimal
          ? formatTrackRes(optimal.width, optimal.height, optimal.frameRate)
          : "N/A",
        volumePct: Math.round(videoEl.volume * 100),
        muted: videoEl.muted,
        videoCodec: active?.videoCodec ?? "N/A",
        audioCodec: active?.audioCodec ?? "N/A",
        videoId: active?.videoId != null ? String(active.videoId) : "",
        audioId: active?.audioId != null ? String(active.audioId) : "",
        colorGamut: active?.colorGamut ?? null,
        hdr: active?.hdr ?? null,
        estimatedBandwidthKbps: Math.round(stats.estimatedBandwidth / 1000),
        networkActivityKBps: Math.round(networkDelta / 1024),
        bufferHealthSec: Math.round(bufferHealth * 100) / 100,
        streamBandwidth: stats.streamBandwidth,
        loadLatency: Math.round(stats.loadLatency * 1000) / 1000,
        gapsJumped: stats.gapsJumped,
        stallsDetected: stats.stallsDetected,
        manifestSizeBytes: stats.manifestSizeBytes,
        date: new Date().toString(),
      };
    }

    // Initial collection
    setData(collect());

    const id = setInterval(() => {
      setData(collect());
    }, 1000);

    return () => clearInterval(id);
  }, [player, videoEl]);

  if (!data) return null;

  const showColor = data.colorGamut != null || data.hdr != null;

  return (
    <div className="vp-stats-panel" onClick={(e) => e.stopPropagation()}>
      <button className="vp-stats-close" onClick={onClose}>
        ×
      </button>

      {/* Row 1: Manifest */}
      <div className="vp-stats-row">
        <span className="vp-stats-label">Manifest</span>
        <span className="vp-stats-value">
          {data.assetUri}
          {data.manifestType ? ` (${data.manifestType})` : ""}
        </span>
      </div>

      {/* Row 2: Viewport / Frames */}
      <div className="vp-stats-row">
        <span className="vp-stats-label">Viewport / Frames</span>
        <span className="vp-stats-value">
          {data.viewport} / {data.droppedFrames} dropped of {data.decodedFrames}
        </span>
      </div>

      {/* Row 3: Current / Optimal Res */}
      <div className="vp-stats-row">
        <span className="vp-stats-label">Current / Optimal Res</span>
        <span className="vp-stats-value">
          {data.currentRes} / {data.optimalRes}
        </span>
      </div>

      {/* Row 4: Volume / Normalized */}
      <div className="vp-stats-row">
        <span className="vp-stats-label">Volume / Normalized</span>
        <span className="vp-stats-value">
          {data.volumePct}% / {data.muted ? "muted" : "unmuted"}
        </span>
      </div>

      {/* Row 5: Codecs */}
      <div className="vp-stats-row">
        <span className="vp-stats-label">Codecs</span>
        <span className="vp-stats-value">
          {data.videoCodec}
          {data.videoId ? ` (${data.videoId})` : ""} /{" "}
          {data.audioCodec}
          {data.audioId ? ` (${data.audioId})` : ""}
        </span>
      </div>

      {/* Row 6: Color (hidden if unavailable) */}
      {showColor && (
        <div className="vp-stats-row">
          <span className="vp-stats-label">Color</span>
          <span className="vp-stats-value">
            {data.colorGamut ?? "N/A"} / {data.hdr ?? "N/A"}
          </span>
        </div>
      )}

      {/* Row 7: Connection Speed */}
      <div className="vp-stats-bar-row">
        <span className="vp-stats-label">Connection Speed</span>
        <StatsBar value={data.estimatedBandwidthKbps} max={20000} />
        <span className="vp-stats-bar-value">
          {data.estimatedBandwidthKbps} Kbps
        </span>
      </div>

      {/* Row 8: Network Activity */}
      <div className="vp-stats-bar-row">
        <span className="vp-stats-label">Network Activity</span>
        <StatsBar value={data.networkActivityKBps} max={2048} />
        <span className="vp-stats-bar-value">
          {data.networkActivityKBps} KB/s
        </span>
      </div>

      {/* Row 9: Buffer Health */}
      <div className="vp-stats-bar-row">
        <span className="vp-stats-label">Buffer Health</span>
        <StatsBar value={data.bufferHealthSec} max={30} />
        <span className="vp-stats-bar-value">{data.bufferHealthSec} s</span>
      </div>

      {/* Row 10: Mystery Text */}
      <div className="vp-stats-row">
        <span className="vp-stats-label">Mystery Text</span>
        <span className="vp-stats-value">
          s:{data.streamBandwidth} t:{data.loadLatency} g:{data.gapsJumped}/
          {data.stallsDetected} m:{data.manifestSizeBytes}
        </span>
      </div>

      {/* Row 11: Date */}
      <div className="vp-stats-row">
        <span className="vp-stats-label">Date</span>
        <span className="vp-stats-value">{data.date}</span>
      </div>
    </div>
  );
}

import { createPortal } from "react-dom";
import shaka from "shaka-player";
import type { ExportRendition } from "../hooks/useSegmentExport";
import { formatBitrate } from "../utils/formatBitrate";

interface ExportPickerProps {
  player: shaka.Player;
  containerEl: HTMLDivElement;
  onSelect: (rendition: ExportRendition) => void;
  onClose: () => void;
}

export default function ExportPicker({
  player,
  containerEl,
  onSelect,
  onClose,
}: ExportPickerProps) {
  const manifest = player.getManifest();
  const variants = manifest?.variants ?? [];
  const seen = new Map<string, ExportRendition>();
  for (const v of variants) {
    if (!v.video || v.video.height == null) continue;
    const vbw = v.video.bandwidth ?? v.bandwidth;
    const key = `${v.video.height}_${vbw}`;
    if (!seen.has(key)) {
      seen.set(key, {
        width: v.video.width ?? 0,
        height: v.video.height,
        videoCodec: v.video.codecs ?? "",
        bandwidth: vbw,
      });
    }
  }
  const renditions = Array.from(seen.values()).sort(
    (a, b) => b.height - a.height || b.bandwidth - a.bandwidth,
  );

  return createPortal(
    <div
      className="vp-export-picker"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="vp-export-picker-card">
        <div className="vp-export-picker-header">
          Save MP4 — select rendition
        </div>
        {renditions.map((r) => (
          <div
            key={`${r.height}_${r.bandwidth}`}
            className="vp-export-picker-item"
            onClick={() => onSelect(r)}
          >
            {r.height}p
            <span className="vp-export-picker-detail">
              {r.videoCodec}
              {" · "}
              {formatBitrate(r.bandwidth)}
            </span>
          </div>
        ))}
        <div className="vp-export-picker-cancel" onClick={onClose}>
          Cancel
        </div>
      </div>
    </div>,
    containerEl,
  );
}

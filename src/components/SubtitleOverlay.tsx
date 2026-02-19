import type { SubCue } from "../hooks/useMultiSubtitles";

interface SubtitleOverlayProps {
  activeCues: Map<number, SubCue[]>;
  trackOrder: number[];
}

export default function SubtitleOverlay({
  activeCues,
  trackOrder,
}: SubtitleOverlayProps) {
  // Only render tracks that have visible cues, in selection order
  const visibleTracks = trackOrder.filter((id) => activeCues.has(id));
  if (visibleTracks.length === 0) return null;

  return (
    <div className="vp-subtitle-overlay">
      {visibleTracks.map((trackId) => {
        const cues = activeCues.get(trackId)!;
        return (
          <div key={trackId} className="vp-subtitle-track">
            {cues.map((cue, i) => (
              <span key={i} className="vp-subtitle-cue">
                {cue.text}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

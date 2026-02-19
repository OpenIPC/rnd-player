import { useState, useRef, useCallback, useEffect } from "react";
import type { SubCue } from "../hooks/useMultiSubtitles";

interface TextTrackOption {
  id: number;
  language: string;
  label: string;
}

interface SubtitleOverlayProps {
  activeCues: Map<number, SubCue[]>;
  trackOrder: number[];
  controlsVisible: boolean;
  textTracks: TextTrackOption[];
  resetSignal: number;
}

const STORAGE_KEY = "vp_subtitle_positions";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function trackKey(track: TextTrackOption): string {
  return `${track.language}:${track.label}`;
}

function loadPositions(): Map<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, number>;
      return new Map(Object.entries(obj));
    }
  } catch {
    // corrupt or unavailable
  }
  return new Map();
}

function savePositions(positions: Map<string, number>): void {
  try {
    const obj: Record<string, number> = {};
    for (const [k, v] of positions) {
      obj[k] = v;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // localStorage unavailable
  }
}

export default function SubtitleOverlay({
  activeCues,
  trackOrder,
  controlsVisible,
  textTracks,
  resetSignal,
}: SubtitleOverlayProps) {
  const [positions, setPositions] = useState<Map<string, number>>(() => loadPositions());
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const dragRef = useRef<{ trackKey: string; startY: number; startBottom: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Sync from localStorage on mount (in case another tab changed it)
  useEffect(() => {
    setPositions(loadPositions());
  }, []);

  // Reset all positions when signal changes (context menu "Reset subtitle positions")
  useEffect(() => {
    if (resetSignal > 0) {
      setPositions(new Map());
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  }, [resetSignal]);

  const findTrack = useCallback(
    (trackId: number): TextTrackOption | undefined => {
      return textTracks.find((t) => t.id === trackId);
    },
    [textTracks],
  );

  const hasSavedPosition = useCallback(
    (trackId: number): boolean => {
      const track = findTrack(trackId);
      if (!track) return false;
      return positions.has(trackKey(track));
    },
    [findTrack, positions],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent, trackId: number) => {
      const track = findTrack(trackId);
      if (!track) return;
      const key = trackKey(track);
      const overlay = overlayRef.current;
      if (!overlay) return;

      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);

      // Measure current bottom position (works for both flex-stacked and absolute)
      const overlayRect = overlay.getBoundingClientRect();
      const trackRect = el.getBoundingClientRect();
      const bottomPx = overlayRect.bottom - trackRect.bottom;
      const currentBottom = (bottomPx / overlayRect.height) * 100;

      // If in default stack, promote to absolute by saving this position
      if (!positions.has(key)) {
        setPositions((prev) => new Map(prev).set(key, currentBottom));
      }

      dragRef.current = { trackKey: key, startY: e.clientY, startBottom: currentBottom };
      setDraggingKey(key);
    },
    [findTrack, positions],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current || !overlayRef.current) return;
      const containerHeight = overlayRef.current.clientHeight;
      if (containerHeight === 0) return;
      const deltaY = dragRef.current.startY - e.clientY;
      const deltaPct = (deltaY / containerHeight) * 100;
      const newBottom = clamp(dragRef.current.startBottom + deltaPct, 0, 85);
      const key = dragRef.current.trackKey;
      setPositions((prev) => {
        const next = new Map(prev);
        next.set(key, newBottom);
        return next;
      });
    },
    [],
  );

  const onPointerUp = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDraggingKey(null);
    // Persist after drag ends
    setPositions((current) => {
      savePositions(current);
      return current;
    });
  }, []);

  const onDoubleClick = useCallback(
    (trackId: number) => {
      const track = findTrack(trackId);
      if (!track) return;
      const key = trackKey(track);
      setPositions((prev) => {
        const next = new Map(prev);
        next.delete(key);
        savePositions(next);
        return next;
      });
    },
    [findTrack],
  );

  // Only render tracks that have visible cues, in selection order
  const visibleTracks = trackOrder.filter((id) => activeCues.has(id));
  if (visibleTracks.length === 0) return null;

  const defaultTracks = visibleTracks.filter((id) => !hasSavedPosition(id));
  const positionedTracks = visibleTracks.filter((id) => hasSavedPosition(id));

  const renderCues = (trackId: number) => {
    const cues = activeCues.get(trackId)!;
    return cues.map((cue, i) => (
      <span key={i} className="vp-subtitle-cue">
        {cue.text}
      </span>
    ));
  };

  return (
    <div ref={overlayRef} className="vp-subtitle-overlay">
      {/* Default-positioned tracks: flex column-reverse stacking */}
      {defaultTracks.length > 0 && (
        <div className={`vp-subtitle-stack${controlsVisible ? "" : " vp-subs-low"}`}>
          {defaultTracks.map((trackId) => {
            const track = findTrack(trackId);
            const key = track ? trackKey(track) : String(trackId);
            const isDragging = draggingKey === key;
            return (
              <div
                key={trackId}
                className={`vp-subtitle-track${isDragging ? " vp-dragging" : ""}`}
                onPointerDown={(e) => onPointerDown(e, trackId)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onDoubleClick={() => onDoubleClick(trackId)}
              >
                {renderCues(trackId)}
              </div>
            );
          })}
        </div>
      )}

      {/* Custom-positioned tracks: absolute with saved bottom% */}
      {positionedTracks.map((trackId) => {
        const track = findTrack(trackId)!;
        const key = trackKey(track);
        const bottom = positions.get(key)!;
        const isDragging = draggingKey === key;
        return (
          <div
            key={trackId}
            className={`vp-subtitle-track vp-subtitle-positioned${isDragging ? " vp-dragging" : ""}`}
            style={{ bottom: `${bottom}%` }}
            onPointerDown={(e) => onPointerDown(e, trackId)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => onDoubleClick(trackId)}
          >
            {renderCues(trackId)}
          </div>
        );
      })}
    </div>
  );
}

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
  onCopyText?: (text: string) => void;
}

const STORAGE_KEY = "vp_subtitle_positions";

// Per-track subtitle colors: bright, high-contrast on dark background.
// White for primary, yellow for secondary (industry convention), then
// distinct hues that stay readable on rgba(8,8,8,0.75) cue backgrounds.
const TRACK_COLORS = [
  "#ffffff", // white — standard primary
  "#ffff00", // yellow — classic secondary (DVD, many Asian players)
  "#00ffff", // cyan
  "#00ff00", // lime
  "#ff80ab", // pink
  "#ffa726", // orange
  "#ce93d8", // lavender
  "#80deea", // light teal
  "#c5e1a5", // light green
];

// Minimum pointer movement (px) before a pointerdown is treated as a drag
// rather than a click-to-copy gesture.
const DRAG_THRESHOLD = 5;

interface DragState {
  trackKey: string;
  trackId: number;
  startY: number;
  startBottom: number;
  moved: boolean;
}

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
  onCopyText,
}: SubtitleOverlayProps) {
  const [positions, setPositions] = useState<Map<string, number>>(() => loadPositions());
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Refs for values needed in stable callbacks
  const activeCuesRef = useRef(activeCues);
  activeCuesRef.current = activeCues;
  const onCopyTextRef = useRef(onCopyText);
  onCopyTextRef.current = onCopyText;

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

      // Don't promote to absolute yet — wait for movement to exceed threshold
      dragRef.current = {
        trackKey: key,
        trackId,
        startY: e.clientY,
        startBottom: currentBottom,
        moved: false,
      };
    },
    [findTrack],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current || !overlayRef.current) return;

      if (!dragRef.current.moved) {
        const dy = Math.abs(e.clientY - dragRef.current.startY);
        if (dy < DRAG_THRESHOLD) return;

        // First time exceeding threshold — begin actual drag
        dragRef.current.moved = true;

        // Promote to absolute if track is in default stack
        const key = dragRef.current.trackKey;
        setPositions((prev) => {
          if (prev.has(key)) return prev;
          return new Map(prev).set(key, dragRef.current!.startBottom);
        });
        setDraggingKey(key);
      }

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
    const { moved, trackId } = dragRef.current;
    dragRef.current = null;
    setDraggingKey(null);

    if (moved) {
      // Drag ended — persist position
      setPositions((current) => {
        savePositions(current);
        return current;
      });
    } else {
      // Click (no movement) — copy subtitle text
      const cues = activeCuesRef.current.get(trackId);
      if (cues && onCopyTextRef.current) {
        onCopyTextRef.current(cues.map((c) => c.text).join("\n"));
      }
    }
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

  const getTrackColor = (trackId: number): string => {
    const index = textTracks.findIndex((t) => t.id === trackId);
    if (index < 0) return TRACK_COLORS[0];
    return TRACK_COLORS[index % TRACK_COLORS.length];
  };

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
                style={{ "--vp-sub-color": getTrackColor(trackId) } as React.CSSProperties}
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
            style={{ bottom: `${bottom}%`, "--vp-sub-color": getTrackColor(trackId) } as React.CSSProperties}
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

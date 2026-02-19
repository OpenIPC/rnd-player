import { useEffect, useRef, useState, useCallback } from "react";
import shaka from "shaka-player";

export interface SubCue {
  startTime: number;
  endTime: number;
  text: string;
}

export interface TextTrackInfo {
  id: number;
  language: string;
  label: string;
  mimeType: string;
}

/** Parsers keyed by MIME type. Returns null for unsupported formats. */
function createParser(
  mimeType: string,
): shaka.extern.TextParser | null {
  if (mimeType === "text/vtt") return new shaka.text.VttTextParser();
  if (mimeType === "application/x-subrip") return new shaka.text.SrtTextParser();
  if (mimeType === "application/ttml+xml") return new shaka.text.TtmlTextParser();
  // mp4-embedded subtitles (wvtt/stpp) require mp4 demuxing — skip
  return null;
}

/**
 * Hook that manages multiple simultaneous subtitle tracks.
 *
 * Fetches subtitle content from the manifest, parses with Shaka's text parsers,
 * and returns currently-visible cues per track on each timeupdate.
 */
export function useMultiSubtitles(
  player: shaka.Player | null,
  videoEl: HTMLVideoElement | null,
  activeTextIds: Set<number>,
  textTracks: TextTrackInfo[],
): { activeCues: Map<number, SubCue[]>; getContextCues: (trackId: number, time: number, count: number) => { before: SubCue[]; current: SubCue[]; after: SubCue[] } } {
  // Cache: trackId → all parsed cues
  const cueCache = useRef<Map<number, SubCue[]>>(new Map());
  // Loading state: trackId → Promise (to avoid double-fetching)
  const loadingRef = useRef<Map<number, Promise<void>>>(new Map());
  // Stable ref for textTracks to avoid recreating loadTrack on every track list update
  const textTracksRef = useRef(textTracks);
  textTracksRef.current = textTracks;

  const [activeCues, setActiveCues] = useState<Map<number, SubCue[]>>(new Map());

  // Load subtitle content for a track — only depends on player (stable ref)
  const loadTrack = useCallback(
    async (trackId: number) => {
      if (cueCache.current.has(trackId)) return;
      if (loadingRef.current.has(trackId)) {
        await loadingRef.current.get(trackId);
        return;
      }

      if (!player) return;

      const manifest = player.getManifest();
      if (!manifest) return;

      const stream = manifest.textStreams?.find(
        (s: shaka.extern.Stream) => s.id === trackId,
      );
      if (!stream) return;

      const trackInfo = textTracksRef.current.find((t) => t.id === trackId);
      const mimeType = trackInfo?.mimeType ?? stream.mimeType ?? "";
      const parser = createParser(mimeType);
      if (!parser) return;

      const loadPromise = (async () => {
        try {
          await stream.createSegmentIndex();
          const index = stream.segmentIndex;
          if (!index) return;

          const allCues: SubCue[] = [];

          // Iterate all segment references
          const iter = index[Symbol.iterator]();
          let result = iter.next();
          while (!result.done) {
            const ref = result.value as shaka.media.SegmentReference;
            const uris = ref.getUris();
            if (uris.length === 0) {
              result = iter.next();
              continue;
            }

            try {
              const resp = await fetch(uris[0]);
              if (!resp.ok) {
                result = iter.next();
                continue;
              }

              const buffer = await resp.arrayBuffer();
              const time = {
                periodStart: 0,
                segmentStart: ref.getStartTime(),
                segmentEnd: ref.getEndTime(),
                vttOffset: 0,
              };

              const parsed = parser.parseMedia(
                new Uint8Array(buffer),
                time,
                null,
                [],
              );
              if (parsed) {
                for (const cue of parsed) {
                  allCues.push({
                    startTime: cue.startTime,
                    endTime: cue.endTime,
                    text: cue.payload,
                  });
                }
              }
            } catch {
              // Skip segments that fail to fetch/parse
            }
            result = iter.next();
          }

          // Sort by start time
          allCues.sort((a, b) => a.startTime - b.startTime);
          cueCache.current.set(trackId, allCues);
        } catch {
          // Parsing failed — treat as empty
          cueCache.current.set(trackId, []);
        } finally {
          loadingRef.current.delete(trackId);
        }
      })();

      loadingRef.current.set(trackId, loadPromise);
      await loadPromise;
    },
    [player],
  );

  // Load newly-activated tracks, clean up deactivated ones
  useEffect(() => {
    // Clean up deactivated tracks from cache
    for (const id of cueCache.current.keys()) {
      if (!activeTextIds.has(id)) {
        cueCache.current.delete(id);
      }
    }

    // Load active tracks
    for (const id of activeTextIds) {
      loadTrack(id);
    }
  }, [activeTextIds, loadTrack]);

  // Filter visible cues on timeupdate
  useEffect(() => {
    if (!videoEl || activeTextIds.size === 0) {
      setActiveCues(new Map());
      return;
    }

    const onTimeUpdate = () => {
      const time = videoEl.currentTime;
      const next = new Map<number, SubCue[]>();

      for (const trackId of activeTextIds) {
        const cues = cueCache.current.get(trackId);
        if (!cues) continue;

        const visible = cues.filter(
          (c) => c.startTime <= time && time < c.endTime,
        );
        if (visible.length > 0) {
          next.set(trackId, visible);
        }
      }

      setActiveCues(next);
    };

    // Run once immediately
    onTimeUpdate();

    videoEl.addEventListener("timeupdate", onTimeUpdate);
    videoEl.addEventListener("seeked", onTimeUpdate);
    return () => {
      videoEl.removeEventListener("timeupdate", onTimeUpdate);
      videoEl.removeEventListener("seeked", onTimeUpdate);
    };
  }, [videoEl, activeTextIds]);

  const getContextCues = useCallback(
    (trackId: number, time: number, count: number) => {
      const empty = { before: [] as SubCue[], current: [] as SubCue[], after: [] as SubCue[] };
      const cues = cueCache.current.get(trackId);
      if (!cues || cues.length === 0) return empty;

      // Find the first cue that is active at `time`
      const idx = cues.findIndex((c) => c.startTime <= time && time < c.endTime);
      if (idx < 0) return empty;

      const current = [cues[idx]];
      const before = cues.slice(Math.max(0, idx - count), idx);
      const after = cues.slice(idx + 1, idx + 1 + count);
      return { before, current, after };
    },
    [],
  );

  return { activeCues, getContextCues };
}

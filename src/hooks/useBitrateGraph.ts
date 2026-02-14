import { useEffect, useRef, useState, useCallback } from "react";
import shaka from "shaka-player";

export interface SegmentBitrateInfo {
  startTime: number;
  endTime: number;
  bitrateBps: number;
  measured: boolean;
}

export interface BitrateGraphData {
  segments: SegmentBitrateInfo[];
  maxBitrateBps: number;
  avgBitrateBps: number;
  renditionLabel: string;
  loading: boolean;
}

interface CapturedSegment {
  startTime: number;
  endTime: number;
  bytes: number;
  streamId: string;
}

function makeStreamId(stream: shaka.extern.Stream): string {
  return `${stream.height ?? 0}_${stream.codecs}`;
}

function getActiveVideoStream(player: shaka.Player): shaka.extern.Stream | null {
  const tracks = player.getVariantTracks();
  const active = tracks.find((t) => t.active);
  if (!active) return null;
  const manifest = player.getManifest();
  if (!manifest?.variants?.length) return null;
  for (const v of manifest.variants) {
    if (
      v.video &&
      v.video.width === active.width &&
      v.video.height === active.height &&
      v.video.codecs === active.videoCodec
    ) {
      return v.video;
    }
  }
  return null;
}

const EMPTY: BitrateGraphData = {
  segments: [],
  maxBitrateBps: 0,
  avgBitrateBps: 0,
  renditionLabel: "",
  loading: true,
};

export function useBitrateGraph(
  player: shaka.Player | null,
  enabled: boolean,
): BitrateGraphData {
  const [data, setData] = useState<BitrateGraphData>(EMPTY);

  // All captured segment sizes, persists across rendition switches
  const capturedRef = useRef<Map<string, CapturedSegment>>(new Map());
  // Current active stream id
  const activeStreamIdRef = useRef<string>("");

  const rebuild = useCallback((
    player: shaka.Player,
    streamId: string,
    timeline: { startTime: number; endTime: number }[],
  ) => {
    const captured = capturedRef.current;
    const tracks = player.getVariantTracks();
    const active = tracks.find((t) => t.active);
    const bandwidth = active?.bandwidth ?? 0;
    const label = active?.height ? `${active.height}p` : "";

    const segments: SegmentBitrateInfo[] = [];
    let maxBps = 0;
    let sumBps = 0;

    for (const seg of timeline) {
      const dur = seg.endTime - seg.startTime;
      if (dur <= 0) continue;

      const key = `${streamId}:${seg.startTime}`;
      const cap = captured.get(key);

      let bitrateBps: number;
      let measured: boolean;

      if (cap) {
        bitrateBps = (cap.bytes * 8) / dur;
        measured = true;
      } else {
        // Estimate from variant bandwidth
        bitrateBps = bandwidth;
        measured = false;
      }

      if (bitrateBps > maxBps) maxBps = bitrateBps;
      sumBps += bitrateBps;

      segments.push({ startTime: seg.startTime, endTime: seg.endTime, bitrateBps, measured });
    }

    const avgBps = segments.length > 0 ? sumBps / segments.length : 0;

    setData({
      segments,
      maxBitrateBps: maxBps,
      avgBitrateBps: avgBps,
      renditionLabel: label,
      loading: false,
    });
  }, []);

  useEffect(() => {
    if (!enabled || !player) return;

    let cancelled = false;
    // Timeline for the current rendition
    let currentTimeline: { startTime: number; endTime: number }[] = [];
    // Debounce timer for rebuild
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRebuild = () => {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        if (cancelled || !player) return;
        rebuild(player, activeStreamIdRef.current, currentTimeline);
      }, 200);
    };

    // Extract segment timeline from active rendition
    const extractTimeline = async () => {
      const stream = getActiveVideoStream(player);
      if (!stream || cancelled) return;

      const streamId = makeStreamId(stream);
      activeStreamIdRef.current = streamId;

      try {
        await stream.createSegmentIndex();
      } catch {
        return;
      }
      if (cancelled) return;

      const segIndex = stream.segmentIndex;
      if (!segIndex) return;

      const timeline: { startTime: number; endTime: number }[] = [];

      // Also try to get byte sizes from byte-range references
      for (const ref of segIndex) {
        if (!ref) continue;
        const startTime = ref.getStartTime();
        const endTime = ref.getEndTime();
        timeline.push({ startTime, endTime });

        // If byte-range addressed, we can compute exact size without network
        const startByte = ref.getStartByte();
        const endByte = ref.getEndByte();
        if (endByte != null && startByte >= 0) {
          const bytes = endByte - startByte + 1;
          const key = `${streamId}:${startTime}`;
          if (!capturedRef.current.has(key)) {
            capturedRef.current.set(key, {
              startTime,
              endTime,
              bytes,
              streamId,
            });
          }
        }
      }

      currentTimeline = timeline;
      if (!cancelled) {
        rebuild(player, streamId, timeline);
      }
    };

    // Response filter to capture actual segment byte sizes
    const responseFilter: shaka.extern.ResponseFilter = (
      type: shaka.net.NetworkingEngine.RequestType,
      response: shaka.extern.Response,
      context?: shaka.extern.RequestContext,
    ) => {
      if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT) return;
      if (!context?.segment || !context?.stream) return;

      const stream = context.stream;
      if (stream.type !== "video") return;

      const streamId = makeStreamId(stream);
      const startTime = context.segment.getStartTime();
      const endTime = context.segment.getEndTime();
      const bytes = response.data.byteLength;

      const key = `${streamId}:${startTime}`;
      capturedRef.current.set(key, { startTime, endTime, bytes, streamId });

      // Only rebuild if this segment belongs to the currently active rendition
      if (streamId === activeStreamIdRef.current) {
        scheduleRebuild();
      }
    };

    const net = player.getNetworkingEngine();
    if (net) {
      net.registerResponseFilter(responseFilter);
    }

    // Listen for rendition changes
    const onRenditionChange = () => {
      if (cancelled) return;
      extractTimeline();
    };

    player.addEventListener("variantchanged", onRenditionChange);
    player.addEventListener("adaptation", onRenditionChange);

    // Initial extraction
    extractTimeline();

    return () => {
      cancelled = true;
      if (rebuildTimer) clearTimeout(rebuildTimer);
      const n = player.getNetworkingEngine();
      if (n) {
        n.unregisterResponseFilter(responseFilter);
      }
      player.removeEventListener("variantchanged", onRenditionChange);
      player.removeEventListener("adaptation", onRenditionChange);
    };
  }, [player, enabled, rebuild]);

  if (!enabled || !player) return EMPTY;
  return data;
}

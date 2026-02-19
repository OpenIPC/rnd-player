/**
 * QualityCompare — split-slider rendition comparator.
 *
 * Runs two Shaka Player instances side-by-side: the original "master" video
 * (right/B-side, has audio, controlled by VideoControls) and a muted "slave"
 * video (left/A-side) clipped via CSS `clip-path`. A draggable vertical
 * divider controls the split position.
 *
 * ## Dual-manifest support
 *
 * When `slaveSrc !== src`, the slave player loads a different manifest,
 * enabling comparison of different encoders, CDNs, or encoding settings.
 * Each side gets its own quality dropdown populated from its own manifest's
 * variant tracks. DRM detection is performed independently for the slave
 * manifest — if it has a different KID, a key prompt is shown.
 *
 * ## Sync strategy
 *
 * All frame-accurate sync goes through one path: the master's `seeked` event.
 *
 * - **Keyboard frame step / seek bar**: master seeks → `seeked` fires →
 *   slave's `currentTime` is set to match. This is inherently reliable
 *   because both videos are paused and the browser decodes the exact frame.
 *
 * - **Click-to-pause**: slave is paused, then master's position is re-asserted
 *   (`masterVideo.currentTime = masterVideo.currentTime`) which triggers the
 *   same `seeked` → slave sync path. This avoids the race condition of seeking
 *   a video that is still transitioning from playing to paused.
 *
 * - **During playback**: a `requestAnimationFrame` loop adjusts the slave's
 *   `playbackRate` by ±3% to smoothly converge drift under 16ms. Hard seeks
 *   are only used for large drifts (>200ms, e.g. after initial load).
 *   Rate-based correction avoids decoder flicker that hard seeks cause.
 *
 * ## DRM / encrypted content
 *
 * ClearKey credentials (kid + key) are forwarded to the slave player.
 * For dual-manifest mode, the slave manifest is fetched independently to
 * detect its KID. If it matches the master's KID, the same key is reused.
 * If different, a key prompt is shown.
 * Note: `canvas.drawImage()` cannot capture frames from EME-protected video
 * elements — the browser returns black pixels. Any frame-buffering strategy
 * must avoid canvas capture for encrypted streams.
 *
 * ## Duration mismatch
 *
 * When comparing two different manifests with different durations, the slave
 * is clamped to its own duration. Seeks beyond the slave's duration pause it.
 *
 * ## Pixel alignment
 *
 * A `ResizeObserver` on the master video element reads its exact
 * `offsetWidth`/`offsetHeight` and applies those as inline pixel dimensions
 * on the slave, ensuring both elements are identically sized regardless of
 * CSS `object-fit` rounding differences.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import shaka from "shaka-player";
import { hasClearKeySupport, waitForDecryption, configureSoftwareDecryption } from "../utils/softwareDecrypt";
import { fetchWithCorsRetry, installCorsSchemePlugin } from "../utils/corsProxy";
import { getFrameTypeAtTime, clearFrameTypeCache } from "../utils/getFrameTypeAtTime";
import type { FrameType } from "../types/thumbnailWorker.types";

const FRAME_TYPE_COLORS: Record<FrameType, string> = {
  I: "rgb(255, 50, 50)",
  P: "rgb(60, 130, 255)",
  B: "rgb(50, 200, 50)",
};

interface QualityCompareProps {
  videoEl: HTMLVideoElement;
  player: shaka.Player;
  src: string;
  slaveSrc: string;
  clearKey?: string;
  kid?: string;
  initialHeightA?: number;
  initialHeightB?: number;
  onResolutionChange?: (heightA: number | null, heightB: number | null) => void;
  onClose: () => void;
}

interface RenditionOption {
  height: number;
  bandwidth: number;
  videoCodec: string;
}

/** Short codec label: "avc1.4d401f" → "AVC", "hvc1.1.6.L93.B0" → "HEVC", etc. */
function shortCodec(codec: string | null | undefined): string {
  if (!codec) return "";
  const base = codec.split(".")[0].toLowerCase();
  switch (base) {
    case "avc1": case "avc3": return "AVC";
    case "hvc1": case "hev1": return "HEVC";
    case "av01": return "AV1";
    case "vp8": return "VP8";
    case "vp9": case "vp09": return "VP9";
    default: return base;
  }
}

function dedupeByHeight(tracks: shaka.extern.Track[]): RenditionOption[] {
  const byHeight = new Map<number, RenditionOption>();
  for (const t of tracks) {
    if (t.height == null) continue;
    const existing = byHeight.get(t.height);
    if (!existing || t.bandwidth > existing.bandwidth) {
      byHeight.set(t.height, { height: t.height, bandwidth: t.bandwidth, videoCodec: t.videoCodec ?? "" });
    }
  }
  return Array.from(byHeight.values()).sort((a, b) => b.height - a.height);
}

function selectByHeight(player: shaka.Player, height: number) {
  const tracks = player.getVariantTracks();
  let best: shaka.extern.Track | null = null;
  for (const t of tracks) {
    if (t.height === height) {
      if (!best || t.bandwidth > best.bandwidth) best = t;
    }
  }
  if (best) {
    player.configure("abr.enabled", false);
    player.selectVariantTrack(best, true);
  }
}

function formatFrameSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function domainLabel(url: string): string {
  try {
    const host = new URL(url).hostname;
    // Extract second-level domain: "sub.example.com" → "example.com"
    const parts = host.split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : host;
  } catch {
    return url.length > 30 ? url.slice(0, 27) + "..." : url;
  }
}

export default function QualityCompare({
  videoEl: masterVideo,
  player: masterPlayer,
  src,
  slaveSrc,
  clearKey,
  kid,
  initialHeightA,
  initialHeightB,
  onResolutionChange,
  onClose,
}: QualityCompareProps) {
  const slaveVideoRef = useRef<HTMLVideoElement>(null);
  const slavePlayerRef = useRef<shaka.Player | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const interactRef = useRef<HTMLDivElement>(null);

  // ── Zoom/pan refs (no re-renders per wheel tick / pointer move) ──
  const zoomRef = useRef(1);
  const panXRef = useRef(0);
  const panYRef = useRef(0);
  const panningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const masterTransformRef = useRef<string>("");

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 8;
  const ZOOM_SPEED = 0.002;
  const ZOOM_STEP = 1.15;

  const [sliderPct, setSliderPct] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [qualitiesA, setQualitiesA] = useState<RenditionOption[]>([]);
  const [qualitiesB, setQualitiesB] = useState<RenditionOption[]>([]);
  const [sideA, setSideA] = useState<number | null>(null);
  const [sideB, setSideB] = useState<number | null>(null);
  const [slaveReady, setSlaveReady] = useState(false);
  const [masterRect, setMasterRect] = useState<{ w: number; h: number } | null>(null);
  const [needsSlaveKey, setNeedsSlaveKey] = useState(false);
  const [slaveKey, setSlaveKey] = useState<string | undefined>(undefined);
  const [paused, setPaused] = useState(masterVideo.paused);
  const [frameInfoA, setFrameInfoA] = useState<{ type: FrameType; size: number } | null>(null);
  const [frameInfoB, setFrameInfoB] = useState<{ type: FrameType; size: number } | null>(null);
  const [zoomDisplay, setZoomDisplay] = useState(1);

  const isDualManifest = slaveSrc !== src;

  // ── Zoom/pan helpers ──
  const applyTransform = useCallback(() => {
    const z = zoomRef.current;
    const tx = panXRef.current;
    const ty = panYRef.current;
    const transform = z === 1
      ? ""
      : `scale(${z}) translate(${tx}px, ${ty}px)`;
    const origin = z === 1 ? "" : "0 0";

    const slaveVideo = slaveVideoRef.current;
    if (slaveVideo) {
      slaveVideo.style.transform = transform;
      slaveVideo.style.transformOrigin = origin;
    }
    masterVideo.style.transform = transform;
    masterVideo.style.transformOrigin = origin;

    setZoomDisplay(z);

    // Update cursor on interaction layer
    const el = interactRef.current;
    if (el) {
      el.style.cursor = panningRef.current ? "grabbing" : "grab";
    }
  }, [masterVideo]);

  const clampPan = useCallback(() => {
    const z = zoomRef.current;
    // In CSS: transform = scale(z) translate(tx, ty)
    // CSS evaluates left-to-right: translate first, then scale.
    // Visible region in video coords: from -tx to -tx + containerW/z
    // Constraint: video left edge (0) <= visible left, visible right <= videoW
    // → 0 >= tx and tx >= (1 - z) * containerW / z ... but since translate is in
    //   pre-scale coords and the container IS the video:
    //   screen offset of video top-left = tx * z, must be <= 0 (can't move right of origin)
    //   screen offset of video bottom-right = tx*z + containerW*z, must be >= containerW
    //   → tx * z <= 0  → tx <= 0
    //   → tx * z >= containerW * (1 - z)  → tx >= containerW * (1 - z) / z
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const w = rect.width;
    const h = rect.height;
    const minTx = w * (1 - z) / z;
    const minTy = h * (1 - z) / z;
    panXRef.current = Math.max(minTx, Math.min(0, panXRef.current));
    panYRef.current = Math.max(minTy, Math.min(0, panYRef.current));
  }, []);

  const resetZoom = useCallback(() => {
    zoomRef.current = 1;
    panXRef.current = 0;
    panYRef.current = 0;
    applyTransform();
  }, [applyTransform]);

  // ── Match slave dimensions to master's exact rendered size ──
  // Uses ResizeObserver contentBoxSize for sub-pixel accuracy (offsetWidth/
  // offsetHeight round to integers which can cause a 1px mismatch).
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentBoxSize?.[0];
      const w = box ? box.inlineSize : masterVideo.offsetWidth;
      const h = box ? box.blockSize : masterVideo.offsetHeight;
      setMasterRect((prev) => (prev?.w === w && prev?.h === h ? prev : { w, h }));
    });
    // Initial measurement
    const { offsetWidth: w, offsetHeight: h } = masterVideo;
    setMasterRect({ w, h });
    ro.observe(masterVideo);
    return () => ro.disconnect();
  }, [masterVideo]);

  // Remember master's original ABR state so we can restore on close
  const masterAbrWasEnabled = useRef(true);

  // ── Initialize slave player ──
  useEffect(() => {
    const slaveVideo = slaveVideoRef.current;
    if (!slaveVideo) return;

    let destroyed = false;
    const slavePlayer = new shaka.Player();
    slavePlayerRef.current = slavePlayer;

    // Save master ABR state and disable it immediately so the master
    // doesn't adapt (downgrade) during the slave's async initialization.
    const abrConfig = masterPlayer.getConfiguration().abr;
    masterAbrWasEnabled.current = abrConfig?.enabled !== false;
    masterPlayer.configure("abr.enabled", false);

    slavePlayer.attach(slaveVideo).then(async () => {
      if (destroyed) return;

      // Determine DRM credentials for the slave
      let slaveKid = kid;
      let slaveClearKey = clearKey;

      if (isDualManifest) {
        // Fetch slave manifest to detect its KID independently
        try {
          const { text: slaveManifestText, corsWorkaround: slaveCorsWorkaround } = await fetchWithCorsRetry(slaveSrc);
          if (destroyed) return;

          // If the slave manifest required a CORS workaround (e.g. the CDN
          // rejects requests with a Referer header from this origin), install
          // the global CORS scheme plugin so Shaka's network engine also
          // uses credentials-less, referrer-less fetches for segment requests.
          if (slaveCorsWorkaround) {
            installCorsSchemePlugin();
          }

          if (slaveManifestText) {
            const doc = new DOMParser().parseFromString(slaveManifestText, "text/xml");
            const cp = doc.querySelector("[*|default_KID]");
            slaveKid = cp?.getAttribute("cenc:default_KID")?.replaceAll("-", "") ?? undefined;
          } else {
            slaveKid = undefined;
          }
        } catch {
          if (destroyed) return;
          slaveKid = undefined;
        }

        if (slaveKid) {
          if (slaveKid === kid && clearKey) {
            // Same KID as master — reuse master's key
            slaveClearKey = clearKey;
          } else if (slaveKey) {
            // User already provided a key for this slave
            slaveClearKey = slaveKey;
          } else {
            // Different KID, no key yet — prompt user
            setNeedsSlaveKey(true);
            return;
          }
        } else {
          slaveClearKey = undefined;
        }
      }

      // Configure DRM if needed
      if (slaveKid && slaveClearKey) {
        if (await hasClearKeySupport()) {
          slavePlayer.configure({
            drm: { clearKeys: { [slaveKid]: slaveClearKey } },
          });
        } else {
          configureSoftwareDecryption(slavePlayer, slaveClearKey);
        }
      }

      try {
        // Load slave at master's current position so Shaka fetches
        // segments from the right time directly (avoids green frame
        // from seeking after a t=0 load).
        const masterTime = masterVideo.currentTime;
        const startTime = masterTime > 0 ? masterTime : undefined;

        await slavePlayer.load(slaveSrc, startTime);
        if (destroyed) return;

        // Verify EME decryption works; fall back to software if not
        if (slaveKid && slaveClearKey && await hasClearKeySupport()) {
          const emeWorks = await waitForDecryption(slaveVideo);
          if (destroyed) return;
          if (!emeWorks) {
            await slavePlayer.unload();
            if (destroyed) return;
            slavePlayer.configure({ drm: { clearKeys: {} } });
            configureSoftwareDecryption(slavePlayer, slaveClearKey);
            await slavePlayer.load(slaveSrc, startTime);
            if (destroyed) return;
          }
        }

        slaveVideo.muted = true;

        // Get available qualities — independent lists for dual-manifest
        const slaveTracks = slavePlayer.getVariantTracks();
        const slaveRenditions = dedupeByHeight(slaveTracks);
        setQualitiesA(slaveRenditions);

        const masterTracks = masterPlayer.getVariantTracks();
        const masterRenditions = dedupeByHeight(masterTracks);
        setQualitiesB(masterRenditions);

        // Pick initial resolutions
        let pickA: number | undefined;
        let pickB: number | undefined;

        if (initialHeightA && slaveRenditions.some((r) => r.height === initialHeightA)) {
          pickA = initialHeightA;
        }
        if (initialHeightB && masterRenditions.some((r) => r.height === initialHeightB)) {
          pickB = initialHeightB;
        }

        if (!pickA || !pickB) {
          if (isDualManifest) {
            // Dual-manifest: both sides default to the highest common resolution
            const slaveHeights = new Set(slaveRenditions.map((r) => r.height));
            const commonHeight = masterRenditions.find((r) => slaveHeights.has(r.height))?.height;
            if (!pickA) pickA = commonHeight ?? slaveRenditions[0]?.height;
            if (!pickB) pickB = commonHeight ?? masterRenditions[0]?.height;
          } else {
            // Same manifest: A=lowest, B=highest (existing behavior)
            if (!pickA) pickA = slaveRenditions[slaveRenditions.length - 1]?.height;
            if (!pickB) pickB = masterRenditions[0]?.height;
          }
        }

        if (pickA) {
          setSideA(pickA);
          selectByHeight(slavePlayer, pickA);
        }

        if (pickB) {
          setSideB(pickB);
          selectByHeight(masterPlayer, pickB);
        }

        onResolutionChange?.(pickA ?? null, pickB ?? null);

        // Sync initial position (clamped to slave duration).
        // Wait for the seek to complete so the decoder produces a valid
        // frame before we show the slave (prevents green flash).
        const clampedTime = Math.min(
          masterVideo.currentTime,
          slaveVideo.duration || Infinity,
        );
        slaveVideo.currentTime = clampedTime;
        await new Promise<void>((resolve) => {
          if (!slaveVideo.seeking) {
            resolve();
            return;
          }
          const onSeeked = () => {
            slaveVideo.removeEventListener("seeked", onSeeked);
            resolve();
          };
          slaveVideo.addEventListener("seeked", onSeeked);
        });
        if (destroyed) return;

        if (!masterVideo.paused) {
          slaveVideo.play().catch(() => {});
        }

        setSlaveReady(true);
      } catch (e: unknown) {
        // LOAD_INTERRUPTED (7000) is expected when effect re-runs or unmounts
        const code = (e as { code?: number }).code;
        if (code === 7000) return;
        console.error("QualityCompare: failed to load slave player", e);
      }
    });

    return () => {
      destroyed = true;
      setSlaveReady(false);
      slavePlayer.destroy();
      slavePlayerRef.current = null;

      // Restore ABR on master
      if (masterAbrWasEnabled.current) {
        masterPlayer.configure("abr.enabled", true);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onResolutionChange/initialHeight are stable from parent
  }, [slaveSrc, clearKey, kid, slaveKey, masterPlayer, masterVideo, isDualManifest, src, initialHeightA, initialHeightB]);

  // ── Sync slave to master ──
  useEffect(() => {
    const slaveVideo = slaveVideoRef.current;
    if (!slaveVideo || !slaveReady) return;

    const onPlay = () => {
      // Don't play slave if master is past slave's duration
      if (slaveVideo.duration && masterVideo.currentTime > slaveVideo.duration) return;
      slaveVideo.play().catch(() => {});
    };
    const onPause = () => {
      slaveVideo.pause();
      // Re-assert master's position to fire its `seeked` event, which
      // triggers onSeeked → slave sync — the same proven path as
      // keyboard frame stepping.
      masterVideo.currentTime = masterVideo.currentTime;
    };
    const onSeeked = () => {
      // Clamp slave time to its own duration
      const clampedTime = Math.min(
        masterVideo.currentTime,
        slaveVideo.duration || Infinity,
      );
      slaveVideo.currentTime = clampedTime;
    };

    masterVideo.addEventListener("play", onPlay);
    masterVideo.addEventListener("pause", onPause);
    masterVideo.addEventListener("seeked", onSeeked);

    // rAF drift correction — rate adjustment for small drifts,
    // hard seek only for large ones
    let rafId: number;
    const syncLoop = () => {
      if (!slaveVideo.paused && !masterVideo.paused) {
        // Pause slave if master time exceeds slave duration
        if (slaveVideo.duration && masterVideo.currentTime > slaveVideo.duration) {
          slaveVideo.pause();
        } else {
          const drift = slaveVideo.currentTime - masterVideo.currentTime;
          const absDrift = Math.abs(drift);
          if (absDrift > 0.2) {
            slaveVideo.currentTime = masterVideo.currentTime;
            slaveVideo.playbackRate = masterVideo.playbackRate;
          } else if (absDrift > 0.016) {
            slaveVideo.playbackRate =
              masterVideo.playbackRate * (drift > 0 ? 0.97 : 1.03);
          } else {
            slaveVideo.playbackRate = masterVideo.playbackRate;
          }
        }
      }
      rafId = requestAnimationFrame(syncLoop);
    };
    rafId = requestAnimationFrame(syncLoop);

    return () => {
      cancelAnimationFrame(rafId);
      masterVideo.removeEventListener("play", onPlay);
      masterVideo.removeEventListener("pause", onPause);
      masterVideo.removeEventListener("seeked", onSeeked);
    };
  }, [masterVideo, slaveReady]);

  // ── Track master pause state ──
  useEffect(() => {
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    setPaused(masterVideo.paused);
    masterVideo.addEventListener("play", onPlay);
    masterVideo.addEventListener("pause", onPause);
    return () => {
      masterVideo.removeEventListener("play", onPlay);
      masterVideo.removeEventListener("pause", onPause);
    };
  }, [masterVideo]);

  // ── Frame type detection (I/P/B borders when paused) ──
  useEffect(() => {
    if (!paused || !slaveReady) {
      setFrameInfoA(null);
      setFrameInfoB(null);
      return;
    }

    let cancelled = false;

    const detectTypes = async () => {
      const slavePlayer = slavePlayerRef.current;
      if (!slavePlayer || cancelled) return;

      const time = masterVideo.currentTime;
      const [infoA, infoB] = await Promise.all([
        getFrameTypeAtTime(slavePlayer, time),
        getFrameTypeAtTime(masterPlayer, time),
      ]);

      if (!cancelled) {
        setFrameInfoA(infoA);
        setFrameInfoB(infoB);
      }
    };

    detectTypes();

    const onSeeked = () => detectTypes();
    masterVideo.addEventListener("seeked", onSeeked);

    return () => {
      cancelled = true;
      masterVideo.removeEventListener("seeked", onSeeked);
    };
  }, [paused, slaveReady, masterPlayer, masterVideo]);

  // Clear frame type cache on unmount
  useEffect(() => {
    return () => clearFrameTypeCache();
  }, []);

  // ── Wheel zoom (document-level, passive: false to block browser zoom) ──
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      // Check cursor is within overlay bounds
      if (
        e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top || e.clientY > rect.bottom
      ) return;
      // Only zoom when paused and slave is ready
      if (!masterVideo.paused || !slaveReady) return;
      // Ignore if target is toolbar or select
      const target = e.target as HTMLElement;
      if (target.closest(".vp-compare-toolbar") || target.closest("select")) return;

      e.preventDefault();

      const oldZ = zoomRef.current;
      let newZ: number;
      if (e.ctrlKey) {
        // Pinch gesture — continuous zoom
        newZ = oldZ * Math.exp(-e.deltaY * ZOOM_SPEED);
      } else {
        // Discrete wheel — step zoom
        newZ = e.deltaY < 0 ? oldZ * ZOOM_STEP : oldZ / ZOOM_STEP;
      }
      newZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZ));

      // Keep cursor point stationary
      // Screen-space cursor offset from video top-left = (cursorX - rect.left)
      // In pre-scale coords the cursor maps to: (cursorScreenX - tx_old * oldZ) / oldZ
      // But with transform: scale(Z) translate(tx, ty), the screen position of
      // video point (vx, vy) is (vx + tx) * Z. So the video-space point under
      // the cursor is: vx = cursorScreen / oldZ - tx_old.
      // After zoom: cursorScreen = (vx + tx_new) * newZ → tx_new = cursorScreen / newZ - vx
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const vx = cursorX / oldZ - panXRef.current;
      const vy = cursorY / oldZ - panYRef.current;
      panXRef.current = cursorX / newZ - vx;
      panYRef.current = cursorY / newZ - vy;
      zoomRef.current = newZ;

      clampPan();
      applyTransform();
    };

    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, [masterVideo, slaveReady, clampPan, applyTransform]);

  // ── Save/restore master transform on mount/unmount ──
  useEffect(() => {
    masterTransformRef.current = masterVideo.style.transform;
    return () => {
      masterVideo.style.transform = masterTransformRef.current;
      masterVideo.style.transformOrigin = "";
    };
  }, [masterVideo]);

  // ── Reset zoom on play ──
  useEffect(() => {
    const onPlay = () => resetZoom();
    masterVideo.addEventListener("play", onPlay);
    return () => masterVideo.removeEventListener("play", onPlay);
  }, [masterVideo, resetZoom]);

  // ── Pan handlers ──
  const onPanPointerDown = useCallback((e: React.PointerEvent) => {
    // Don't start pan if target is handle or toolbar
    const target = e.target as HTMLElement;
    if (target.closest(".vp-compare-handle") || target.closest(".vp-compare-toolbar")) return;
    panningRef.current = true;
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: panXRef.current,
      panY: panYRef.current,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (interactRef.current) interactRef.current.style.cursor = "grabbing";
  }, []);

  const onPanPointerMove = useCallback((e: React.PointerEvent) => {
    if (!panningRef.current) return;
    const z = zoomRef.current;
    const dx = (e.clientX - panStartRef.current.x) / z;
    const dy = (e.clientY - panStartRef.current.y) / z;
    panXRef.current = panStartRef.current.panX + dx;
    panYRef.current = panStartRef.current.panY + dy;
    clampPan();
    applyTransform();
  }, [clampPan, applyTransform]);

  const onPanPointerUp = useCallback((e: React.PointerEvent) => {
    if (!panningRef.current) return;
    panningRef.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    if (interactRef.current) interactRef.current.style.cursor = "grab";
  }, []);

  const onPanDoubleClick = useCallback(() => {
    resetZoom();
  }, [resetZoom]);

  // ── Slider drag ──
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSliderPct(Math.max(5, Math.min(95, pct)));
    },
    [dragging],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  // ── Rendition selection ──
  const handleSideAChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const height = Number(e.target.value);
      setSideA(height);
      const slave = slavePlayerRef.current;
      if (slave) selectByHeight(slave, height);
      onResolutionChange?.(height, sideB);
    },
    [onResolutionChange, sideB],
  );

  const handleSideBChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const height = Number(e.target.value);
      setSideB(height);
      selectByHeight(masterPlayer, height);
      onResolutionChange?.(sideA, height);
    },
    [masterPlayer, onResolutionChange, sideA],
  );

  return (
    <div
      ref={containerRef}
      className="vp-compare-overlay"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Slave video (top layer, clipped to left side) */}
      <video
        ref={slaveVideoRef}
        className="vp-compare-video"
        style={{
          clipPath: `inset(0 ${100 - sliderPct}% 0 0)`,
          ...(masterRect && { width: masterRect.w, height: masterRect.h }),
        }}
      />

      {/* Slave key prompt for dual-manifest with different KID */}
      {needsSlaveKey && (
        <div className="vp-key-overlay" onClick={(e) => e.stopPropagation()}>
          <form
            className="vp-key-form"
            onSubmit={(e) => {
              e.preventDefault();
              const value = new FormData(e.currentTarget).get("slave-key") as string;
              if (value?.trim()) {
                setSlaveKey(value.trim());
                setNeedsSlaveKey(false);
              }
            }}
          >
            <div className="vp-key-title">Encrypted compare source</div>
            <div className="vp-key-desc">
              The compare manifest requires a different decryption key
            </div>
            <input
              name="slave-key"
              className="vp-key-input"
              type="password"
              placeholder="Decryption key (hex)"
              autoFocus
            />
            <button type="submit" className="vp-key-submit">
              Decrypt
            </button>
          </form>
        </div>
      )}

      {/* Toolbar */}
      <div className="vp-compare-toolbar" onClick={(e) => e.stopPropagation()}>
        <div className="vp-compare-toolbar-side">
          <span className="vp-compare-label">A</span>
          <select
            className="vp-compare-select"
            value={sideA ?? ""}
            onChange={handleSideAChange}
          >
            {qualitiesA.map((q) => (
              <option key={q.height} value={q.height}>
                {q.height}p{q.videoCodec ? ` ${shortCodec(q.videoCodec)}` : ""}
              </option>
            ))}
          </select>
          {isDualManifest && (
            <span className="vp-compare-src-hint" title={slaveSrc}>
              {domainLabel(slaveSrc)}
            </span>
          )}
        </div>
        <div className="vp-compare-toolbar-side">
          {isDualManifest && (
            <span className="vp-compare-src-hint" title={src}>
              {domainLabel(src)}
            </span>
          )}
          <select
            className="vp-compare-select"
            value={sideB ?? ""}
            onChange={handleSideBChange}
          >
            {qualitiesB.map((q) => (
              <option key={q.height} value={q.height}>
                {q.height}p{q.videoCodec ? ` ${shortCodec(q.videoCodec)}` : ""}
              </option>
            ))}
          </select>
          <span className="vp-compare-label">B</span>
          <button
            className="vp-compare-close"
            onClick={onClose}
            title="Close compare"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Frame type borders (visible when paused) */}
      {frameInfoA && (
        <div
          className="vp-compare-frame-border vp-compare-frame-border-left"
          style={{
            left: 0,
            width: `${sliderPct}%`,
            borderColor: FRAME_TYPE_COLORS[frameInfoA.type],
          }}
        >
          <span
            className="vp-compare-frame-badge"
            style={{ backgroundColor: FRAME_TYPE_COLORS[frameInfoA.type] }}
          >
            {frameInfoA.type}
            {frameInfoA.size > 0 && (
              <span className="vp-compare-frame-size">{formatFrameSize(frameInfoA.size)}</span>
            )}
          </span>
        </div>
      )}
      {frameInfoB && (
        <div
          className="vp-compare-frame-border vp-compare-frame-border-right"
          style={{
            left: `${sliderPct}%`,
            right: 0,
            borderColor: FRAME_TYPE_COLORS[frameInfoB.type],
          }}
        >
          <span
            className="vp-compare-frame-badge vp-compare-frame-badge-right"
            style={{ backgroundColor: FRAME_TYPE_COLORS[frameInfoB.type] }}
          >
            {frameInfoB.type}
            {frameInfoB.size > 0 && (
              <span className="vp-compare-frame-size">{formatFrameSize(frameInfoB.size)}</span>
            )}
          </span>
        </div>
      )}

      {/* Interaction layer for pan + double-click (only when zoomed & paused) */}
      {zoomDisplay > 1 && paused && (
        <div
          ref={interactRef}
          className="vp-compare-interact"
          style={{ cursor: "grab" }}
          onPointerDown={onPanPointerDown}
          onPointerMove={onPanPointerMove}
          onPointerUp={onPanPointerUp}
          onDoubleClick={onPanDoubleClick}
        />
      )}

      {/* Zoom indicator */}
      {zoomDisplay > 1 && (
        <div className="vp-compare-zoom-label">{zoomDisplay.toFixed(1)}&times;</div>
      )}

      {/* Slider line + handle */}
      <div
        className="vp-compare-slider"
        style={{ left: `${sliderPct}%` }}
      />
      <div
        className="vp-compare-handle"
        style={{ left: `${sliderPct}%` }}
        onPointerDown={onPointerDown}
        onClick={(e) => e.stopPropagation()}
      >
        <svg width="32" height="32" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="rgba(0,0,0,0.5)" stroke="#fff" strokeWidth="2" />
          <path d="M12 12l-4 4 4 4M20 12l4 4-4 4" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}

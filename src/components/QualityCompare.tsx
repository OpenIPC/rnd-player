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
import { fetchWithCorsRetry, getCorsBlockedOrigin } from "../utils/corsProxy";
import { getFrameTypeAtTime, clearFrameTypeCache } from "../utils/getFrameTypeAtTime";
import type { FrameTypeResult } from "../utils/getFrameTypeAtTime";
import type { FrameType } from "../types/thumbnailWorker.types";
import { formatBitrate } from "../utils/formatBitrate";
import { loadSettings } from "../hooks/useSettings";

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

function collectRenditions(tracks: shaka.extern.Track[]): RenditionOption[] {
  const seen = new Map<string, RenditionOption>();
  for (const t of tracks) {
    if (t.height == null) continue;
    const vbw = t.videoBandwidth ?? t.bandwidth;
    const key = `${t.height}_${vbw}`;
    if (!seen.has(key)) {
      seen.set(key, { height: t.height, bandwidth: vbw, videoCodec: t.videoCodec ?? "" });
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

function selectRendition(player: shaka.Player, height: number, bandwidth?: number) {
  const tracks = player.getVariantTracks();
  let best: shaka.extern.Track | null = null;
  for (const t of tracks) {
    if (t.height === height) {
      if (bandwidth != null && (t.videoBandwidth ?? t.bandwidth) === bandwidth) {
        best = t;
        break;
      }
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

function domainLabel(url: string, otherUrl?: string): string {
  try {
    const host = new URL(url).hostname;
    const parts = host.split(".");
    const sld = parts.length >= 2 ? parts.slice(-2).join(".") : host;

    // When the other URL shares the same second-level domain, show the
    // distinguishing subdomain prefix instead (e.g. "msk2-cdp4" vs "pre-edge-cdp1").
    if (otherUrl) {
      try {
        const otherHost = new URL(otherUrl).hostname;
        const otherParts = otherHost.split(".");
        const otherSld = otherParts.length >= 2 ? otherParts.slice(-2).join(".") : otherHost;
        if (sld === otherSld && parts.length > 2) {
          return parts.slice(0, -2).join(".");
        }
      } catch { /* otherUrl invalid — fall through to default */ }
    }

    return sld;
  } catch {
    return url.length > 30 ? url.slice(0, 27) + "..." : url;
  }
}

function GopBar({ frames, activeIdx }: { frames: { type: FrameType; size: number }[]; activeIdx: number }) {
  const maxSize = Math.max(...frames.map((f) => f.size), 1);
  return (
    <div className="vp-compare-gop">
      {frames.map((f, i) => (
        <div
          key={i}
          className={`vp-compare-gop-bar vp-gop-bar-${f.type}${i === activeIdx ? " vp-compare-gop-active" : ""}`}
          style={{ height: `${Math.max(8, (f.size / maxSize) * 100)}%` }}
        />
      ))}
    </div>
  );
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
  const sliderPctRef = useRef(50);

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 8;
  const ZOOM_SPEED = 0.002;
  const ZOOM_STEP = 1.15;

  const [sliderPct, setSliderPct] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [qualitiesA, setQualitiesA] = useState<RenditionOption[]>([]);
  const [qualitiesB, setQualitiesB] = useState<RenditionOption[]>([]);
  const [sideA, setSideA] = useState<string | null>(null);
  const [sideB, setSideB] = useState<string | null>(null);
  const [slaveReady, setSlaveReady] = useState(false);
  const [needsSlaveKey, setNeedsSlaveKey] = useState(false);
  const [slaveKey, setSlaveKey] = useState<string | undefined>(undefined);
  const [paused, setPaused] = useState(masterVideo.paused);
  const [frameInfoA, setFrameInfoA] = useState<FrameTypeResult | null>(null);
  const [frameInfoB, setFrameInfoB] = useState<FrameTypeResult | null>(null);
  const [zoomDisplay, setZoomDisplay] = useState(1);
  const [slaveError, setSlaveError] = useState<string | null>(null);
  const errorCloseRef = useRef<HTMLButtonElement>(null);
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(0 as never);

  const isDualManifest = slaveSrc !== src;

  const copyUrl = useCallback((url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedMsg("URL copied");
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedMsg(null), 2000);
    });
  }, []);

  // ── Native click handler on error close button ──
  // React's onClick fires via event delegation at the root, so stopPropagation
  // runs too late — the native click handler on .vp-container has already
  // toggled play/pause. A native handler on the button itself fires during
  // bubble phase before reaching .vp-container.
  useEffect(() => {
    const btn = errorCloseRef.current;
    if (!btn) return;
    const handler = (e: MouseEvent) => {
      e.stopPropagation();
      onClose();
    };
    btn.addEventListener("click", handler);
    return () => btn.removeEventListener("click", handler);
  }, [slaveError, onClose]);

  // ── Zoom/pan helpers ──

  // Adjust slave clip-path so the visual split stays at the slider's
  // screen position regardless of zoom/pan.  With transform:
  //   scale(z) translate(tx, ty)  [origin 0 0]
  // local point lx maps to screen (lx + tx) * z.
  // We want the clip boundary at screen position sliderPct% of container:
  //   clipLocal = sliderPct / 100 * containerW / z - tx
  //   clipLocalPct = sliderPct / z - tx * 100 / containerW
  const updateClipPath = useCallback(() => {
    const slaveVideo = slaveVideoRef.current;
    if (!slaveVideo) return;
    const z = zoomRef.current;
    if (z === 1) {
      slaveVideo.style.clipPath = `inset(0 ${100 - sliderPctRef.current}% 0 0)`;
      return;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clipPct = sliderPctRef.current / z - panXRef.current * 100 / rect.width;
    const rightInset = Math.max(0, Math.min(100, 100 - clipPct));
    slaveVideo.style.clipPath = `inset(0 ${rightInset}% 0 0)`;
  }, []);

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

    updateClipPath();
    setZoomDisplay(z);

    // Update cursor on interaction layer
    const el = interactRef.current;
    if (el) {
      el.style.cursor = panningRef.current ? "grabbing" : "grab";
    }
  }, [masterVideo, updateClipPath]);

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

      slavePlayer.addEventListener("error", (event) => {
        const detail = (event as CustomEvent).detail;
        console.error(
          "QualityCompare slave error: severity=%d category=%d code=%d",
          detail.severity,
          detail.category,
          detail.code,
        );
        if (detail.severity === 2) {
          if (detail.category === 1) {
            const blockedHost = getCorsBlockedOrigin(slaveSrc);
            if (blockedHost) {
              setSlaveError(`${blockedHost} blocked cross-origin access from ${window.location.hostname}. Try loading the player from localhost.`);
            } else {
              setSlaveError("Compare source: network error loading segments.");
            }
          } else if (detail.category === 6) {
            setSlaveError("Compare source: DRM decryption error.");
          } else {
            setSlaveError(`Compare source error (code ${detail.code}).`);
          }
        }
      });

      // Determine DRM credentials for the slave
      let slaveKid = kid;
      let slaveClearKey = clearKey;

      if (isDualManifest) {
        // Fetch slave manifest to detect its KID independently
        try {
          const { text: slaveManifestText } = await fetchWithCorsRetry(slaveSrc);
          if (destroyed) return;

          if (slaveManifestText) {
            const doc = new DOMParser().parseFromString(slaveManifestText, "text/xml");
            const cp = doc.querySelector("[*|default_KID]");
            slaveKid = cp?.getAttribute("cenc:default_KID")?.replaceAll("-", "") ?? undefined;
          } else {
            const corsBlocked = getCorsBlockedOrigin(slaveSrc);
            if (corsBlocked) {
              setSlaveError(`${corsBlocked} blocked cross-origin access from ${window.location.hostname}. Try loading the player from localhost.`);
              return;
            }
            slaveKid = undefined;
          }
        } catch {
          if (destroyed) return;
          setSlaveError("Failed to load compare manifest. Check the URL or your connection.");
          return;
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
        const slaveRenditions = collectRenditions(slaveTracks);
        setQualitiesA(slaveRenditions);

        const masterTracks = masterPlayer.getVariantTracks();
        const masterRenditions = collectRenditions(masterTracks);
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
          const rA = slaveRenditions.find((r) => r.height === pickA);
          setSideA(rA ? `${rA.height}_${rA.bandwidth}` : `${pickA}_0`);
          selectRendition(slavePlayer, pickA);
        }

        if (pickB) {
          const rB = masterRenditions.find((r) => r.height === pickB);
          setSideB(rB ? `${rB.height}_${rB.bandwidth}` : `${pickB}_0`);
          selectRendition(masterPlayer, pickB);
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
        if (destroyed) return;
        console.error("QualityCompare: failed to load slave player", e);
        if (e instanceof shaka.util.Error) {
          if (e.category === 1) {
            const blockedHost = getCorsBlockedOrigin(slaveSrc);
            if (blockedHost) {
              setSlaveError(`${blockedHost} blocked cross-origin access from ${window.location.hostname}. Try loading the player from localhost.`);
            } else {
              setSlaveError("Compare source failed to load: network error.");
            }
          } else if (e.category === 6) {
            setSlaveError("Compare source failed to load: DRM error.");
          } else {
            setSlaveError(`Compare source failed to load (code ${e.code}).`);
          }
        } else {
          setSlaveError("Compare source failed to load.");
        }
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
      // Ignore events outside the compare overlay DOM tree (e.g. portaled modals)
      const target = e.target as HTMLElement;
      if (!container.contains(target)) return;
      // Ignore if target is toolbar or select
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

  // ── Adjust pan on container resize (e.g. fullscreen toggle) ──
  // The viewport center is at element-relative fraction:
  //   rel = (cw/(2z) - tx) / cw
  // Scaling tx proportionally preserves this fraction after resize:
  //   tx_new = tx_old * (newW / oldW)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let prevW = container.offsetWidth;
    let prevH = container.offsetHeight;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentBoxSize?.[0];
      const newW = box ? box.inlineSize : container.offsetWidth;
      const newH = box ? box.blockSize : container.offsetHeight;

      if (newW === prevW && newH === prevH) return;

      const z = zoomRef.current;
      if (z > 1) {
        panXRef.current *= newW / prevW;
        panYRef.current *= newH / prevH;
        clampPan();
        applyTransform();
      }

      prevW = newW;
      prevH = newH;
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, [clampPan, applyTransform]);

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

    // Minimal movement → click → play (which resets zoom via onPlay handler)
    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    if (dx * dx + dy * dy < 25) {
      masterVideo.play().catch(() => {});
    }
  }, [masterVideo]);

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

  // ── Keep sliderPctRef in sync and update clip-path when zoomed ──
  useEffect(() => {
    sliderPctRef.current = sliderPct;
    updateClipPath();
  }, [sliderPct, updateClipPath]);

  // ── Rendition selection ──
  const handleSideAChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      const [h, bw] = val.split("_").map(Number);
      setSideA(val);
      const slave = slavePlayerRef.current;
      if (slave) selectRendition(slave, h, bw);
      const sideBHeight = sideB ? Number(sideB.split("_")[0]) : null;
      onResolutionChange?.(h, sideBHeight);
    },
    [onResolutionChange, sideB],
  );

  const handleSideBChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      const [h, bw] = val.split("_").map(Number);
      setSideB(val);
      selectRendition(masterPlayer, h, bw);
      const sideAHeight = sideA ? Number(sideA.split("_")[0]) : null;
      onResolutionChange?.(sideAHeight, h);
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

      {/* Slave load error */}
      {slaveError && (
        <div className="vp-compare-error">
          <div className="vp-compare-error-message">{slaveError}</div>
          <button ref={errorCloseRef} className="vp-compare-error-close">
            Close compare
          </button>
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
            {qualitiesA.map((q) => {
              const showBw = qualitiesA.filter((r) => r.height === q.height).length > 1 || loadSettings().alwaysShowBitrate;
              return (
                <option key={`${q.height}_${q.bandwidth}`} value={`${q.height}_${q.bandwidth}`}>
                  {q.height}p{q.videoCodec ? ` ${shortCodec(q.videoCodec)}` : ""}{showBw ? ` ${formatBitrate(q.bandwidth)}` : ""}
                </option>
              );
            })}
          </select>
          {isDualManifest && (
            <span className="vp-compare-src-hint" title={slaveSrc} onClick={() => copyUrl(slaveSrc)}>
              {domainLabel(slaveSrc, src)}
            </span>
          )}
        </div>
        <div className="vp-compare-toolbar-side">
          {isDualManifest && (
            <span className="vp-compare-src-hint" title={src} onClick={() => copyUrl(src)}>
              {domainLabel(src, slaveSrc)}
            </span>
          )}
          <select
            className="vp-compare-select"
            value={sideB ?? ""}
            onChange={handleSideBChange}
          >
            {qualitiesB.map((q) => {
              const showBw = qualitiesB.filter((r) => r.height === q.height).length > 1 || loadSettings().alwaysShowBitrate;
              return (
                <option key={`${q.height}_${q.bandwidth}`} value={`${q.height}_${q.bandwidth}`}>
                  {q.height}p{q.videoCodec ? ` ${shortCodec(q.videoCodec)}` : ""}{showBw ? ` ${formatBitrate(q.bandwidth)}` : ""}
                </option>
              );
            })}
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
            right: `${100 - sliderPct}%`,
            borderColor: FRAME_TYPE_COLORS[frameInfoA.type],
          }}
        >
          <div className="vp-compare-frame-stack">
            {frameInfoA.gopFrames.length > 1 && (
              <GopBar frames={frameInfoA.gopFrames} activeIdx={frameInfoA.frameIdx} />
            )}
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
          <div className="vp-compare-frame-stack vp-compare-frame-stack-right">
            {frameInfoB.gopFrames.length > 1 && (
              <GopBar frames={frameInfoB.gopFrames} activeIdx={frameInfoB.frameIdx} />
            )}
            <span
              className="vp-compare-frame-badge"
              style={{ backgroundColor: FRAME_TYPE_COLORS[frameInfoB.type] }}
            >
              {frameInfoB.type}
              {frameInfoB.size > 0 && (
                <span className="vp-compare-frame-size">{formatFrameSize(frameInfoB.size)}</span>
              )}
            </span>
          </div>
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

      {/* Copied toast */}
      {copiedMsg && <div className="vp-copied-toast">{copiedMsg}</div>}
    </div>
  );
}

/**
 * QualityCompare — split-slider rendition comparator.
 *
 * Runs two Shaka Player instances side-by-side: the original "master" video
 * (right/B-side, has audio, controlled by VideoControls) and a muted "slave"
 * video (left/A-side) clipped via CSS `clip-path`. A draggable vertical
 * divider controls the split position.
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
 * Note: `canvas.drawImage()` cannot capture frames from EME-protected video
 * elements — the browser returns black pixels. Any frame-buffering strategy
 * must avoid canvas capture for encrypted streams.
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

interface QualityCompareProps {
  videoEl: HTMLVideoElement;
  player: shaka.Player;
  src: string;
  clearKey?: string;
  kid?: string;
  onClose: () => void;
}

interface RenditionOption {
  height: number;
  bandwidth: number;
}

function dedupeByHeight(tracks: shaka.extern.Track[]): RenditionOption[] {
  const byHeight = new Map<number, RenditionOption>();
  for (const t of tracks) {
    if (t.height == null) continue;
    const existing = byHeight.get(t.height);
    if (!existing || t.bandwidth > existing.bandwidth) {
      byHeight.set(t.height, { height: t.height, bandwidth: t.bandwidth });
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

export default function QualityCompare({
  videoEl: masterVideo,
  player: masterPlayer,
  src,
  clearKey,
  kid,
  onClose,
}: QualityCompareProps) {
  const slaveVideoRef = useRef<HTMLVideoElement>(null);
  const slavePlayerRef = useRef<shaka.Player | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [sliderPct, setSliderPct] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [qualities, setQualities] = useState<RenditionOption[]>([]);
  const [sideA, setSideA] = useState<number | null>(null);
  const [sideB, setSideB] = useState<number | null>(null);
  const [slaveReady, setSlaveReady] = useState(false);
  const [masterRect, setMasterRect] = useState<{ w: number; h: number } | null>(null);

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

    // Save master ABR state
    const abrConfig = masterPlayer.getConfiguration().abr;
    masterAbrWasEnabled.current = abrConfig?.enabled !== false;

    slavePlayer.attach(slaveVideo).then(async () => {
      if (destroyed) return;

      // Configure DRM if needed
      if (kid && clearKey) {
        if (await hasClearKeySupport()) {
          slavePlayer.configure({
            drm: { clearKeys: { [kid]: clearKey } },
          });
        } else {
          configureSoftwareDecryption(slavePlayer, clearKey);
        }
      }

      try {
        await slavePlayer.load(src);
        if (destroyed) return;

        // Verify EME decryption works; fall back to software if not
        if (kid && clearKey && await hasClearKeySupport()) {
          const emeWorks = await waitForDecryption(slaveVideo);
          if (destroyed) return;
          if (!emeWorks) {
            await slavePlayer.unload();
            if (destroyed) return;
            slavePlayer.configure({ drm: { clearKeys: {} } });
            configureSoftwareDecryption(slavePlayer, clearKey);
            await slavePlayer.load(src);
            if (destroyed) return;
          }
        }

        slaveVideo.muted = true;

        // Get available qualities from master
        const masterTracks = masterPlayer.getVariantTracks();
        const renditions = dedupeByHeight(masterTracks);
        setQualities(renditions);

        if (renditions.length > 0) {
          // A-side (slave/left): lowest quality by default
          const lowest = renditions[renditions.length - 1];
          setSideA(lowest.height);
          selectByHeight(slavePlayer, lowest.height);

          // B-side (master/right): highest quality by default
          const highest = renditions[0];
          setSideB(highest.height);
          selectByHeight(masterPlayer, highest.height);
        }

        // Sync initial position
        slaveVideo.currentTime = masterVideo.currentTime;
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
  }, [src, clearKey, kid, masterPlayer, masterVideo]);

  // ── Sync slave to master ──
  useEffect(() => {
    const slaveVideo = slaveVideoRef.current;
    if (!slaveVideo || !slaveReady) return;

    const onPlay = () => {
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
      slaveVideo.currentTime = masterVideo.currentTime;
    };

    masterVideo.addEventListener("play", onPlay);
    masterVideo.addEventListener("pause", onPause);
    masterVideo.addEventListener("seeked", onSeeked);

    // rAF drift correction — rate adjustment for small drifts,
    // hard seek only for large ones
    let rafId: number;
    const syncLoop = () => {
      if (!slaveVideo.paused && !masterVideo.paused) {
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
    },
    [],
  );

  const handleSideBChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const height = Number(e.target.value);
      setSideB(height);
      selectByHeight(masterPlayer, height);
    },
    [masterPlayer],
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

      {/* Toolbar */}
      <div className="vp-compare-toolbar" onClick={(e) => e.stopPropagation()}>
        <div className="vp-compare-toolbar-side">
          <span className="vp-compare-label">A</span>
          <select
            className="vp-compare-select"
            value={sideA ?? ""}
            onChange={handleSideAChange}
          >
            {qualities.map((q) => (
              <option key={q.height} value={q.height}>
                {q.height}p
              </option>
            ))}
          </select>
        </div>
        <div className="vp-compare-toolbar-side">
          <select
            className="vp-compare-select"
            value={sideB ?? ""}
            onChange={handleSideBChange}
          >
            {qualities.map((q) => (
              <option key={q.height} value={q.height}>
                {q.height}p
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

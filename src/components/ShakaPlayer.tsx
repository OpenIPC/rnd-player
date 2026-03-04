import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import shaka from "shaka-player";
import VideoControls from "./VideoControls";
import { hasClearKeySupport, waitForDecryption, configureSoftwareDecryption } from "../utils/softwareDecrypt";
import { fetchWithCorsRetry, installCorsSchemePlugin, uninstallCorsSchemePlugin, getCorsBlockedOrigin } from "../utils/corsProxy";
import { isSafariMSE } from "../hooks/useAudioAnalyser";
import { useBoundaryPreviews } from "../hooks/useBoundaryPreviews";
import { useEc3Audio } from "../hooks/useEc3Audio";
import { parseEc3Tracks, parseAllAudioTracks, stripEc3FromManifest, type Ec3TrackInfo } from "../utils/dashAudioParser";
import type { PlayerModuleConfig } from "../types/moduleConfig";
import type { SceneData } from "../types/sceneData";
import type { DeviceProfile } from "../utils/detectCapabilities";
import type { DrmConfig, WatermarkToken } from "../drm/types";
import { fetchLicense } from "../drm/drmClient";
import { parseManifestDrm } from "../drm/diagnostics/parseManifestDrm";
import { parseInitSegmentDrm } from "../drm/diagnostics/parseInitSegmentDrm";
import type { DrmDiagnosticsState } from "../drm/diagnostics/types";
import { createSessionManager, type SessionManager } from "../drm/sessionManager";
const FilmstripTimeline = lazy(() => import("./FilmstripTimeline"));
const QualityCompare = lazy(() => import("./QualityCompare"));
const WatermarkOverlay = lazy(() => import("./WatermarkOverlay"));
const DrmDiagnosticsPanel = lazy(() => import("./DrmDiagnosticsPanel"));
const DebugPanel = import.meta.env.DEV ? lazy(() => import("./DebugPanel")) : null;
import "./ShakaPlayer.css";

export interface CompareViewState {
  zoom: number;
  panXFrac: number;
  panYFrac: number;
  sliderPct: number;
  highlightX?: number;
  highlightY?: number;
  highlightW?: number;
  highlightH?: number;
  cmode?: string;
  flickerInterval?: number;
  amplification?: number;
  palette?: string;
  vmafModel?: string;
}

interface ShakaPlayerProps {
  src: string;
  autoPlay?: boolean;
  clearKey?: string;
  startTime?: number;
  drmConfig?: DrmConfig;
  compareSrc?: string;
  compareQa?: number;
  compareQb?: number;
  compareZoom?: number;
  comparePx?: number;
  comparePy?: number;
  compareSplit?: number;
  compareHx?: number;
  compareHy?: number;
  compareHw?: number;
  compareHh?: number;
  compareCmode?: string;
  compareCfi?: number;
  compareAmp?: number;
  comparePal?: string;
  compareVmodel?: string;
  moduleConfig: PlayerModuleConfig;
  deviceProfile: DeviceProfile;
  onModuleConfigChange: (config: PlayerModuleConfig) => void;
  sceneData?: SceneData | null;
  onSceneDataChange?: (data: SceneData | null) => void;
  onLoadSceneData?: () => void;
  onLoadSceneFile?: (file: File) => void;
  scenesUrl?: string | null;
}

/** Quick scan for a 4-byte box type in ISOBMFF data (top-level only). */
function findBox(data: Uint8Array, fourcc: string): boolean {
  const c0 = fourcc.charCodeAt(0), c1 = fourcc.charCodeAt(1);
  const c2 = fourcc.charCodeAt(2), c3 = fourcc.charCodeAt(3);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset + 8 <= data.length) {
    if (data[offset + 4] === c0 && data[offset + 5] === c1 &&
        data[offset + 6] === c2 && data[offset + 7] === c3) return true;
    const size = view.getUint32(offset);
    if (size < 8) break;
    offset += size;
  }
  return false;
}

let polyfillsInstalled = false;

function describeLoadError(e: shaka.util.Error): string {
  // BAD_HTTP_STATUS (1001): data = [uri, httpStatus, responseText, headers, requestType]
  if (e.code === 1001 && e.data?.[1]) {
    const httpStatus = e.data[1] as number;
    if (httpStatus === 410) {
      return "The video stream has expired (HTTP 410 Gone). Try obtaining a fresh CDN link.";
    }
    if (httpStatus === 403) {
      return "Access denied (HTTP 403). The stream URL may have expired or require authentication.";
    }
    if (httpStatus === 404) {
      return "Video not found (HTTP 404). The stream may have been removed.";
    }
    return `Failed to load video (HTTP ${httpStatus}). Check the stream URL.`;
  }
  return `Failed to load video (code ${e.code}).`;
}

function ShakaPlayer({ src, autoPlay = false, clearKey, startTime, drmConfig, compareSrc, compareQa, compareQb, compareZoom, comparePx, comparePy, compareSplit, compareHx, compareHy, compareHw, compareHh, compareCmode, compareCfi, compareAmp, comparePal, compareVmodel, moduleConfig, deviceProfile, onModuleConfigChange, sceneData, onSceneDataChange, onLoadSceneData, onLoadSceneFile, scenesUrl }: ShakaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<shaka.Player | null>(null);
  const kidRef = useRef<string | null>(null);
  const compareViewRef = useRef<CompareViewState | null>(null);
  const clearSleepGuardRef = useRef<() => void>(() => {});
  const sessionRef = useRef<SessionManager | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [safariMSE, setSafariMSE] = useState(false);
  const [ec3Tracks, setEc3Tracks] = useState<Ec3TrackInfo[]>([]);
  const [allAudioTracks, setAllAudioTracks] = useState<Ec3TrackInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [activeKey, setActiveKey] = useState<string | undefined>(clearKey);
  const [pendingDrmKey, setPendingDrmKey] = useState<string | null>(null);
  const pendingSessionRef = useRef<{ sessionId: string; renewalS: number } | null>(null);
  const [watermark, setWatermark] = useState<WatermarkToken | null>(null);
  const [showDrmDiagnostics, setShowDrmDiagnostics] = useState(false);
  const [drmDiagnosticsState, setDrmDiagnosticsState] = useState<DrmDiagnosticsState>({
    manifest: null,
    initSegment: null,
  });
  const [showFilmstrip, setShowFilmstrip] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [slaveSrc, setSlaveSrc] = useState<string | undefined>(compareSrc);
  const [showCompareModal, setShowCompareModal] = useState(false);
  const [compareHeightA, setCompareHeightA] = useState<number | null>(null);
  const [compareHeightB, setCompareHeightB] = useState<number | null>(null);
  const [inPoint, setInPoint] = useState<number | null>(null);
  const [outPoint, setOutPoint] = useState<number | null>(null);
  const handleInPointChange = useCallback((time: number | null) => {
    setInPoint(time);
    if (time != null) setOutPoint((prev) => (prev != null && prev <= time ? null : prev));
  }, []);
  const handleOutPointChange = useCallback((time: number | null) => {
    setOutPoint(time);
    if (time != null) setInPoint((prev) => (prev != null && prev >= time ? null : prev));
  }, []);
  const [startOffset, setStartOffset] = useState(0);
  const psnrHistoryRef = useRef<Map<number, number>>(new Map());
  const ssimHistoryRef = useRef<Map<number, number>>(new Map());
  const msSsimHistoryRef = useRef<Map<number, number>>(new Map());
  const vmafHistoryRef = useRef<Map<number, number>>(new Map());
  // EC-3 software decode playback
  const ec3Audio = useEc3Audio(videoRef.current);

  // Boundary previews for progress bar tooltip (independent of filmstrip)
  const { boundaryPreviews, requestBoundaryPreview, clearBoundaryPreviews } = useBoundaryPreviews(
    playerRef.current,
    videoRef.current,
    playerReady && !!sceneData && moduleConfig.sceneMarkers,
    activeKey,
  );

  useEffect(() => {
    if (!polyfillsInstalled) {
      shaka.polyfill.installAll();
      shaka.text.TextEngine.registerParser(
        "application/x-subrip",
        () => new shaka.text.SrtTextParser(),
      );
      polyfillsInstalled = true;
    }

    if (!shaka.Player.isBrowserSupported()) {
      console.error("Browser not supported by Shaka Player");
      return;
    }

    const video = videoRef.current!;
    setSafariMSE(isSafariMSE(video));
    const player = new shaka.Player();
    playerRef.current = player;
    let destroyed = false;

    player.attach(video).then(async () => {
      if (destroyed) return;

      if (deviceProfile.maxAudioChannels > 2) {
        player.configure({ preferredAudioChannelCount: deviceProfile.maxAudioChannels });
      }

      player.addEventListener("error", (event) => {
        const detail = (event as CustomEvent).detail;
        console.error(
          "Shaka error: severity=%d category=%d code=%d",
          detail.severity,
          detail.category,
          detail.code,
          "data=",
          detail.data,
        );
        if (detail.severity === 2) {
          // severity 2 = CRITICAL
          if (detail.category === 6) {
            setError("DRM error: unable to decrypt content. Check that the decryption keys are correct.");
          } else if (detail.category === 3) {
            setError(
              kidRef.current
                ? "Media decode error: content could not be decrypted. The provided key may be incorrect."
                : "Media decode error: the video could not be played.",
            );
          } else if (detail.category === 1) {
            const blockedHost = getCorsBlockedOrigin(src);
            if (blockedHost) {
              setError(`${blockedHost} blocked cross-origin access from ${window.location.hostname}. Try loading the player from localhost.`);
            } else {
              setError(describeLoadError(detail));
            }
          } else {
            setError(`Playback error (code ${detail.code}): the video could not be played.`);
          }
        }
      });

      // Read persisted state before loading so we can pass startTime to Shaka
      let savedState: { time: number; paused: boolean } | null = null;
      try {
        const raw = sessionStorage.getItem("vp_playback_state");
        if (raw) {
          savedState = JSON.parse(raw);
        }
      } catch {
        // sessionStorage unavailable
      }

      const loadStartTime =
        startTime != null && startTime > 0
          ? startTime
          : savedState && savedState.time > 0
            ? savedState.time
            : null;

      // Install CORS scheme plugin unconditionally — handles stale browser
      // cache (CDNs returning max-age without Vary: Origin) and credential
      // rejection on segment CDN origins that differ from the manifest origin.
      installCorsSchemePlugin();

      // Fetch manifest and extract cenc:default_KID for ClearKey DRM
      const { text: manifestText } = await fetchWithCorsRetry(src);
      if (destroyed) return;

      if (!manifestText) {
        const corsBlocked = getCorsBlockedOrigin(src);
        if (corsBlocked) {
          setError(`${corsBlocked} blocked cross-origin access from ${window.location.hostname}. Try loading the player from localhost.`);
          return;
        }
      }

      let defaultKID: string | null = null;
      if (manifestText) {
        const doc = new DOMParser().parseFromString(manifestText, "text/xml");
        const cp = doc.querySelector("[*|default_KID]");
        defaultKID =
          cp?.getAttribute("cenc:default_KID")?.replaceAll("-", "") ?? null;

        // Parse all audio tracks (for AudioCompare)
        setAllAudioTracks(parseAllAudioTracks(manifestText, src));

        // Detect EC-3/AC-3 audio tracks that the browser can't decode natively
        const detectedEc3 = parseEc3Tracks(manifestText, src);
        if (detectedEc3.length > 0) {
          setEc3Tracks(detectedEc3);
          // Register a response filter to strip EC-3 AdaptationSets from the
          // manifest so Shaka loads only video + AAC (native) tracks
          const net = player.getNetworkingEngine();
          if (net) {
            net.registerResponseFilter((type, response) => {
              if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
                const xml = new TextDecoder().decode(response.data as ArrayBuffer);
                const stripped = stripEc3FromManifest(xml);
                response.data = new TextEncoder().encode(stripped).buffer as ArrayBuffer;
              }
            });
          }
        } else {
          setEc3Tracks([]);
        }
      }

      kidRef.current = defaultKID;

      // --- DRM diagnostics: parse manifest metadata ---
      if (moduleConfig.drmDiagnostics && manifestText) {
        const { info: manifestDrmInfo, psshBoxes: manifestPsshBoxes } = parseManifestDrm(manifestText);
        setDrmDiagnosticsState((prev) => ({
          ...prev,
          manifest: manifestDrmInfo,
          manifestPsshBoxes,
        }));

        // Register init segment capture filter for PSSH/tenc extraction
        const net = player.getNetworkingEngine();
        if (net) {
          net.registerResponseFilter(async (type, response) => {
            if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT) return;
            const data = response.data as ArrayBuffer;
            if (!data || data.byteLength < 8) return;
            // Check if this is an init segment (contains moov box)
            const bytes = new Uint8Array(data);
            const hasMoov =
              findBox(bytes, "moov") || findBox(bytes, "ftyp");
            if (!hasMoov) return;
            const initInfo = await parseInitSegmentDrm(data);
            if (initInfo) {
              setDrmDiagnosticsState((prev) => prev.initSegment ? prev : { ...prev, initSegment: initInfo });
            }
          });
        }
      }

      // --- DRM key resolution (3-tier priority) ---
      // All DRM paths return early and defer loading to handleKeySubmit
      // via pendingDrmKey. Loading DRM content inside this useEffect's
      // async chain causes playback to stall (Shaka/EME timing issue).
      if (defaultKID && !clearKey && drmConfig) {
        // Priority 2: fetch key from license server.
        // Don't load here — defer to handleKeySubmit via pendingDrmKey
        // so the load happens in a separate async context (matches test 3 flow).
        try {
          const result = await fetchLicense(drmConfig);
          if (destroyed) return;
          pendingSessionRef.current = {
            sessionId: result.license.session_id,
            renewalS: result.license.policy.renewal_interval_s,
          };
          setWatermark(result.watermark ?? null);
          setPendingDrmKey(result.clearKeyHex);
        } catch (e) {
          if (destroyed) return;
          console.warn("[DRM] License fetch failed, falling back to key prompt:", e);
          setNeedsKey(true);
        }
        return;
      } else if (defaultKID && !clearKey) {
        // Priority 3: no key and no config — show manual prompt
        setNeedsKey(true);
        return;
      } else if (defaultKID && clearKey) {
        // Priority 1: ?key= param provided.
        // Defer to handleKeySubmit like priority 2 — loading DRM content
        // inside the main useEffect's async chain causes playback to stall.
        setPendingDrmKey(clearKey);
        return;
      }

      try {
        await player.load(src, loadStartTime);
        if (destroyed) return;

        // Detect B-frame composition time offset (CTO).
        // Compare Shaka's per-track buffer ranges: the video
        // SourceBuffer starts later than audio when HEVC B-frame
        // reordering pushes the first sample's CTS forward (common
        // with ISM-repackaged DASH). This works regardless of
        // whether we loaded from a saved position or from the
        // beginning, because the CTO is constant across segments.
        // Previous approach (video.currentTime at canplay) failed
        // because: (a) it was gated on loadStartTime==null, so
        // repeated loads with sessionStorage-saved position skipped
        // detection entirely; (b) video.currentTime returns the seek
        // target, not the CTO, when loading from a non-zero position.
        {
          const onCanPlay = () => {
            if (destroyed) return;
            const bi = player.getBufferedInfo();
            let offset = 0;

            // --- CTO diagnostic logging (temporary) ---
            console.group("[CTO diagnostic]");
            console.log("loadStartTime:", loadStartTime);
            console.log("video.currentTime:", video.currentTime);
            console.log("video.readyState:", video.readyState);
            console.log("video.buffered.length:", video.buffered.length);
            if (video.buffered.length > 0) {
              console.log(`video.buffered[0]: ${video.buffered.start(0)} – ${video.buffered.end(0)}`);
            }
            console.log("shaka bufferedInfo.audio:", JSON.stringify(bi.audio));
            console.log("shaka bufferedInfo.video:", JSON.stringify(bi.video));
            if (bi.audio.length > 0 && bi.video.length > 0) {
              console.log("audio/video delta:", bi.video[0].start - bi.audio[0].start);
            }
            const timeline = player.getManifest()?.presentationTimeline;
            if (timeline) {
              console.log("seekRangeStart:", timeline.getSeekRangeStart());
              console.log("seekRangeEnd:", timeline.getSeekRangeEnd());
            }
            console.groupEnd();
            // --- end diagnostic ---

            if (bi.audio.length > 0 && bi.video.length > 0) {
              const delta = bi.video[0].start - bi.audio[0].start;
              // CTO is typically 1–3 frames (40–120ms at 25fps).
              // Reject negative deltas (audio starts after video)
              // and implausibly large ones (> 500ms) that indicate
              // segment boundary misalignment rather than CTO.
              if (delta > 0.001 && delta < 0.5) {
                offset = delta;
              }
            } else if (loadStartTime == null) {
              // Video-only or audio-only: fall back to buffered start
              offset =
                video.buffered.length > 0
                  ? video.buffered.start(0)
                  : video.currentTime;
            }
            console.log("[CTO diagnostic] final startOffset:", offset);
            setStartOffset(offset);

            // When CTO is not detected (offset=0), it may be because the
            // audio/video buffer delta is ambiguous at the load position
            // (e.g. loading at t=326s where segment boundaries align).
            // Re-check on seeked/progress events — especially effective
            // when the user seeks near position 0 where the delta between
            // audio start (0) and video start (CTO) is unambiguous.
            if (offset === 0) {
              const redetectCTO = () => {
                if (destroyed) return;
                let bi2: shaka.extern.BufferedInfo;
                try { bi2 = player.getBufferedInfo(); } catch { return; }
                if (bi2.audio.length > 0 && bi2.video.length > 0) {
                  const d = bi2.video[0].start - bi2.audio[0].start;
                  if (d > 0.001 && d < 0.5) {
                    console.log("[CTO re-detect] found CTO:", d);
                    setStartOffset(d);
                    video.removeEventListener("seeked", redetectCTO);
                    video.removeEventListener("progress", redetectCTO);
                  }
                }
              };
              video.addEventListener("seeked", redetectCTO);
              video.addEventListener("progress", redetectCTO);
            }
          };
          if (video.readyState >= 3) {
            onCanPlay();
          } else {
            video.addEventListener("canplay", onCanPlay, { once: true });
          }
        }

        setPlayerReady(true);

        if (savedState) {
          if (!savedState.paused) {
            video.play().catch(() => {});
          }
        } else if (autoPlay) {
          video.play().catch(() => {});
        }
      } catch (e: unknown) {
        if (destroyed) return;
        if (e instanceof shaka.util.Error) {
          console.error("Error loading manifest:", e.code, e.message, "data=", e.data);
          setError(describeLoadError(e));
        } else {
          setError("Failed to load video.");
        }
      }
    });

    return () => {
      destroyed = true;
      setPlayerReady(false);
      kidRef.current = null;
      sessionRef.current?.destroy();
      sessionRef.current = null;
      uninstallCorsSchemePlugin();
      player.destroy();
      playerRef.current = null;
    };
  }, [src, autoPlay, clearKey, startTime, drmConfig]);

  const handleKeySubmit = async (key: string, shouldPlay = true) => {
    setNeedsKey(false);
    setActiveKey(key);

    const player = playerRef.current;
    const kid = kidRef.current;
    if (!player || !kid) return;

    const emeSupported = await hasClearKeySupport();
    if (emeSupported) {
      player.configure({ drm: { clearKeys: { [kid]: key } } });
    } else {
      configureSoftwareDecryption(player, key);
    }

    try {
      await player.load(src);
      setPlayerReady(true);
      if (shouldPlay) videoRef.current?.play().catch(() => {});

      // Start session heartbeat for license-server DRM
      const pending = pendingSessionRef.current;
      if (drmConfig && pending) {
        pendingSessionRef.current = null;
        sessionRef.current = createSessionManager({
          licenseUrl: drmConfig.licenseUrl,
          sessionToken: drmConfig.sessionToken,
          sessionId: pending.sessionId,
          renewalIntervalS: pending.renewalS,
          getPlaybackState: () => {
            const v = videoRef.current;
            const activeTrack = player.getVariantTracks().find((t) => t.active);
            return {
              position_s: v ? v.currentTime : 0,
              buffer_health_s: v && v.buffered.length > 0
                ? v.buffered.end(v.buffered.length - 1) - v.currentTime
                : 0,
              rendition: activeTrack ? `${activeTrack.height}p` : "unknown",
            };
          },
          onRevoked: () => {
            console.warn("[DRM] Session revoked by server (Phase 1: no interruption)");
          },
        });
        sessionRef.current.start();
      }

      // Non-blocking EME fallback: some browsers report ClearKey EME as
      // supported but silently fail to decrypt. Detect in background and
      // reload with software decryption if needed.
      if (emeSupported && videoRef.current) {
        const v = videoRef.current;
        waitForDecryption(v).then(async (emeWorks) => {
          if (emeWorks || !playerRef.current) return;
          await player.unload();
          player.configure({ drm: { clearKeys: {} } });
          configureSoftwareDecryption(player, key);
          await player.load(src);
          v.play().catch(() => {});
        });
      }
    } catch (e: unknown) {
      if (e instanceof shaka.util.Error) {
        console.error("Error loading manifest:", e.code, e.message, "data=", e.data);
        setError(describeLoadError(e));
      } else {
        setError("Failed to load video.");
      }
    }
  };

  // Auto-load when license server resolves a key (deferred from useEffect
  // so the load runs in a separate async context — same as manual key entry).
  useEffect(() => {
    if (pendingDrmKey && !playerReady && !needsKey) {
      const key = pendingDrmKey;
      setPendingDrmKey(null);
      handleKeySubmit(key, false);
    }
  }, [pendingDrmKey, playerReady, needsKey]);

  // Auto-enter compare mode when compareSrc is provided via URL param
  const compareSrcTriggered = useRef(false);
  useEffect(() => {
    if (compareSrc && playerReady && !compareSrcTriggered.current) {
      compareSrcTriggered.current = true;
      setSlaveSrc(compareSrc);
      setCompareMode(true);
    }
  }, [compareSrc, playerReady]);

  const handleToggleCompare = () => {
    if (compareMode) {
      setCompareMode(false);
      setSlaveSrc(undefined);
    } else if (slaveSrc) {
      setCompareMode(true);
    } else {
      setShowCompareModal(true);
    }
  };

  const handleCompareModalSubmit = (url: string) => {
    setSlaveSrc(url);
    setCompareMode(true);
    setShowCompareModal(false);
  };

  return (
    <div ref={containerRef} className={`vp-container${needsKey ? " vp-awaiting-key" : ""}`}>
      <div className="vp-video-area">
        <video ref={videoRef} />
        {needsKey && (
          <div className="vp-key-overlay">
            <form
              className="vp-key-form"
              onSubmit={(e) => {
                e.preventDefault();
                const value = new FormData(e.currentTarget).get("key") as string;
                if (value?.trim()) handleKeySubmit(value.trim());
              }}
            >
              <div className="vp-key-title">Encrypted content</div>
              <div className="vp-key-desc">Enter decryption key to play</div>
              <input
                name="key"
                className="vp-key-input"
                type="password"
                placeholder="Decryption key (hex)"
                autoFocus
              />
              <button type="submit" className="vp-key-submit">
                Play
              </button>
            </form>
          </div>
        )}
        {showCompareModal && (
          <div
            className="vp-compare-modal-overlay"
            onClick={(e) => { e.stopPropagation(); setShowCompareModal(false); }}
          >
            <form
              className="vp-compare-modal"
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault();
                const value = new FormData(e.currentTarget).get("compare-url") as string;
                if (value?.trim()) handleCompareModalSubmit(value.trim());
              }}
            >
              <div className="vp-key-title">Quality compare</div>
              <div className="vp-key-desc">Enter a second manifest URL to compare</div>
              <input
                name="compare-url"
                className="vp-key-input"
                type="url"
                placeholder="Manifest URL (.mpd, .m3u8)"
                autoFocus
              />
              <div className="vp-compare-modal-actions">
                <button type="submit" className="vp-key-submit">
                  Load
                </button>
                <button
                  type="button"
                  className="vp-compare-modal-same"
                  onClick={() => handleCompareModalSubmit(src)}
                >
                  Same source
                </button>
              </div>
            </form>
          </div>
        )}
        {moduleConfig.watermark &&
          watermark &&
          playerReady &&
          videoRef.current && (
            <Suspense fallback={null}>
              <WatermarkOverlay
                videoEl={videoRef.current}
                watermark={watermark}
              />
            </Suspense>
          )}
        {moduleConfig.drmDiagnostics && showDrmDiagnostics && (
            <Suspense fallback={null}>
              <DrmDiagnosticsPanel
                state={drmDiagnosticsState}
                onClose={() => setShowDrmDiagnostics(false)}
              />
            </Suspense>
          )}
        {error && (
          <div className="vp-error-overlay">
            <div className="vp-error-message">{error}</div>
          </div>
        )}
        {playerReady &&
          videoRef.current &&
          containerRef.current &&
          playerRef.current && (
            <VideoControls
              videoEl={videoRef.current}
              containerEl={containerRef.current}
              player={playerRef.current}
              src={src}
              clearKey={activeKey}
              drmConfig={drmConfig}
              showFilmstrip={showFilmstrip}
              onToggleFilmstrip={() => setShowFilmstrip((s) => !s)}
              showCompare={compareMode}
              onToggleCompare={handleToggleCompare}
              compareSrc={compareMode && slaveSrc !== src ? slaveSrc : undefined}
              compareHeightA={compareMode ? compareHeightA : undefined}
              compareHeightB={compareMode ? compareHeightB : undefined}
              compareViewRef={compareViewRef}
              clearSleepGuardRef={clearSleepGuardRef}
              inPoint={inPoint}
              outPoint={outPoint}
              onInPointChange={handleInPointChange}
              onOutPointChange={handleOutPointChange}
              startOffset={startOffset}
              moduleConfig={moduleConfig}
              deviceProfile={deviceProfile}
              onModuleConfigChange={onModuleConfigChange}
              sceneData={sceneData}
              onSceneDataChange={onSceneDataChange}
              onLoadSceneFile={onLoadSceneFile}
              scenesUrl={scenesUrl}
              boundaryPreviews={boundaryPreviews}
              requestBoundaryPreview={requestBoundaryPreview}
              clearBoundaryPreviews={clearBoundaryPreviews}
              safariMSE={safariMSE}
              ec3Tracks={ec3Tracks}
              ec3Audio={ec3Audio}
              allAudioTracks={allAudioTracks}
              showDrmDiagnostics={showDrmDiagnostics}
              onToggleDrmDiagnostics={() => setShowDrmDiagnostics((s) => !s)}
            />
          )}
        {moduleConfig.qualityCompare &&
          compareMode &&
          slaveSrc &&
          playerReady &&
          videoRef.current &&
          playerRef.current && (
            <Suspense fallback={null}>
              <QualityCompare
                videoEl={videoRef.current}
                player={playerRef.current}
                src={src}
                slaveSrc={slaveSrc}
                clearKey={activeKey}
                kid={kidRef.current ?? undefined}
                initialHeightA={compareQa}
                initialHeightB={compareQb}
                initialZoom={compareZoom}
                initialPanXFrac={comparePx}
                initialPanYFrac={comparePy}
                initialSplit={compareSplit}
                initialHighlightX={compareHx}
                initialHighlightY={compareHy}
                initialHighlightW={compareHw}
                initialHighlightH={compareHh}
                initialCmode={compareCmode}
                initialFlickerInterval={compareCfi}
                initialAmp={compareAmp}
                initialPalette={comparePal}
                initialVmafModel={compareVmodel}
                viewStateRef={compareViewRef}
                clearSleepGuardRef={clearSleepGuardRef}
                psnrHistoryRef={psnrHistoryRef}
                ssimHistoryRef={ssimHistoryRef}
                msSsimHistoryRef={msSsimHistoryRef}
                vmafHistoryRef={vmafHistoryRef}
                onResolutionChange={(a, b) => {
                  setCompareHeightA(a);
                  setCompareHeightB(b);
                }}
                onClose={() => {
                  setCompareMode(false);
                  setSlaveSrc(undefined);
                  setCompareHeightA(null);
                  setCompareHeightB(null);
                }}
              />
            </Suspense>
          )}
        {DebugPanel && (
          <Suspense fallback={null}>
            <DebugPanel />
          </Suspense>
        )}
      </div>
      {moduleConfig.filmstrip &&
        showFilmstrip &&
        playerReady &&
        videoRef.current &&
        playerRef.current && (
          <Suspense fallback={null}>
            <FilmstripTimeline
              videoEl={videoRef.current}
              player={playerRef.current}
              onClose={() => setShowFilmstrip(false)}
              clearKey={activeKey}
              inPoint={inPoint}
              outPoint={outPoint}
              startOffset={startOffset}
              psnrHistory={psnrHistoryRef}
              ssimHistory={ssimHistoryRef}
              msSsimHistory={msSsimHistoryRef}
              vmafHistory={vmafHistoryRef}
              sceneData={sceneData}
              onLoadSceneData={onLoadSceneData}
              onClearSceneData={onSceneDataChange ? () => onSceneDataChange(null) : undefined}
            />
          </Suspense>
        )}
    </div>
  );
}

export default ShakaPlayer;

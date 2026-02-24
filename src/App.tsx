import { useState, useEffect, useCallback, useRef } from "react";
import ShakaPlayer from "./components/ShakaPlayer";
import type { PlayerModuleConfig } from "./types/moduleConfig";
import type { SceneData } from "./types/sceneData";
import type { DeviceProfile } from "./utils/detectCapabilities";
import { detectCapabilities } from "./utils/detectCapabilities";
import { autoConfig } from "./utils/autoConfig";
import { parseSceneData } from "./utils/parseSceneData";
import { loadModuleOverrides, loadSettings, saveSettings } from "./hooks/useSettings";
import "./App.css";

function parseUrlParams(): {
  src: string | null;
  startTime: number | null;
  clearKey: string | null;
  compare: string | null;
  compareQa: number | null;
  compareQb: number | null;
  compareZoom: number | null;
  comparePx: number | null;
  comparePy: number | null;
  compareSplit: number | null;
  compareHx: number | null;
  compareHy: number | null;
  compareHw: number | null;
  compareHh: number | null;
  compareCmode: string | null;
  compareCfi: number | null;
  compareAmp: number | null;
  comparePal: string | null;
  compareVmodel: string | null;
  scenes: string | null;
  sceneFps: number | null;
} {
  const params = new URLSearchParams(window.location.search);
  const v = params.get("v");
  const t = params.get("t");
  const key = params.get("key");
  const compare = params.get("compare");
  const qa = params.get("qa");
  const qb = params.get("qb");
  const zoom = params.get("zoom");
  const px = params.get("px");
  const py = params.get("py");
  const split = params.get("split");
  const hx = params.get("hx");
  const hy = params.get("hy");
  const hw = params.get("hw");
  const hh = params.get("hh");
  const cmode = params.get("cmode");
  const cfi = params.get("cfi");
  const amp = params.get("amp");
  const pal = params.get("pal");
  const vmodel = params.get("vmodel");
  const scenes = params.get("scenes");
  const sceneFpsRaw = params.get("sceneFps");

  return {
    src: v || null,
    startTime: t ? parseFloat(t.replace(/s$/, "")) || null : null,
    clearKey: key || null,
    compare: compare || null,
    compareQa: qa ? parseInt(qa, 10) || null : null,
    compareQb: qb ? parseInt(qb, 10) || null : null,
    compareZoom: zoom ? parseFloat(zoom) || null : null,
    comparePx: px ? parseFloat(px) : null,
    comparePy: py ? parseFloat(py) : null,
    compareSplit: split ? parseInt(split, 10) : null,
    compareHx: hx ? parseFloat(hx) : null,
    compareHy: hy ? parseFloat(hy) : null,
    compareHw: hw ? parseFloat(hw) : null,
    compareHh: hh ? parseFloat(hh) : null,
    compareCmode: cmode || null,
    compareCfi: cfi ? parseInt(cfi, 10) || null : null,
    compareAmp: amp ? parseInt(amp, 10) || null : null,
    comparePal: pal || null,
    compareVmodel: vmodel || null,
    scenes: scenes || null,
    sceneFps: sceneFpsRaw ? parseFloat(sceneFpsRaw) || null : null,
  };
}

const DEMO_STREAMS = [
  {
    name: "Multi-Res 1080p",
    description:
      "Multi-resolution multi-rate up to 1080p. AVC, live profile.",
    url: "https://dash.akamaized.net/dash264/TestCasesHD/2b/qualcomm/1/MultiResMPEG2.mpd",
  },
  {
    name: "Single-Res Multi-Rate",
    description:
      "Single resolution with multiple bitrates. Tests bitrate switching without resolution change.",
    url: "https://dash.akamaized.net/dash264/TestCases/1b/qualcomm/1/MultiRatePatched.mpd",
  },
  {
    name: "UHD Multi-Rate",
    description:
      "10-bit Ultra-HD (SDR) live profile with multiple representations for high-resolution ABR.",
    url: "https://dash.akamaized.net/dash264/TestCasesUHD/2b/11/MultiRate.mpd",
  },
  {
    name: "Low-Latency Live",
    description:
      "DASH-IF low-latency chunked transfer with single AVC video and AAC audio.",
    url: "https://livesim.dashif.org/livesim/chunkdur_1/ato_7/testpic4_8s/Manifest.mpd",
  },
  {
    name: "Frame Counter",
    description:
      "60 s, 5 renditions (240p\u20131080p), 30 fps AVC with 4-digit frame counter overlay. Built-in test fixture.",
    url: "https://openipc.github.io/rnd-player/fixtures/frames/manifest.mpd",
  },
  {
    name: "Frame Counter (HEVC)",
    description:
      "60 s, 2 renditions (480p\u20131080p), 30 fps HEVC with B-frames and frame counter overlay. Tests HEVC-specific seek behavior.",
    url: "https://openipc.github.io/rnd-player/fixtures/frames/hevc/manifest.mpd",
  },
];

const initial = parseUrlParams();

function App() {
  const [src, setSrc] = useState<string | null>(initial.src);
  const [clearKey] = useState<string | null>(initial.clearKey);
  const [startTime] = useState<number | null>(initial.startTime);
  const [compareSrc] = useState<string | null>(initial.compare);
  const [showDemo, setShowDemo] = useState(false);
  const [deviceProfile, setDeviceProfile] = useState<DeviceProfile | null>(null);
  const [moduleConfig, setModuleConfig] = useState<PlayerModuleConfig | null>(null);
  const [sceneData, setSceneData] = useState<SceneData | null>(null);
  const [scenesUrl, setScenesUrl] = useState<string | null>(initial.scenes);
  const sceneFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    detectCapabilities().then((profile) => {
      setDeviceProfile(profile);
      const overrides = loadModuleOverrides();
      const preset = typeof __MODULE_PRESET__ !== "undefined" ? __MODULE_PRESET__ : undefined;
      const config = autoConfig(profile, preset);
      // Apply user overrides on top (only for features not hard-gated)
      const merged = { ...config, ...overrides };
      // Re-apply hard gates to ensure user overrides can't enable unsupported features
      if (!profile.webCodecs || !profile.offscreenCanvas) merged.filmstrip = false;
      if (!profile.webGL2) merged.qualityCompare = false;
      if (!profile.webAudio) merged.audioLevels = false;
      if (!profile.workers) merged.segmentExport = false;
      setModuleConfig(merged);
    });
  }, []);

  // Fetch scene data from URL param on mount
  useEffect(() => {
    if (!initial.scenes) return;
    fetch(initial.scenes)
      .then((r) => r.json())
      .then((json) => {
        const fps = initial.sceneFps ?? 30;
        const parsed = parseSceneData(json, fps);
        if (parsed) setSceneData(parsed);
      })
      .catch(() => {
        // Silently ignore fetch/parse errors for scene data
      });
  }, []);

  const sceneDataFpsRef = useRef(30);
  useEffect(() => {
    if (sceneData?.fps) sceneDataFpsRef.current = sceneData.fps;
  }, [sceneData?.fps]);

  const handleSceneFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string);
        const parsed = parseSceneData(json, sceneDataFpsRef.current);
        if (parsed) {
          setSceneData(parsed);
          setScenesUrl(null);
        }
      } catch {
        // Invalid JSON
      }
    };
    reader.readAsText(file);
    // Reset input so the same file can be re-selected
    e.target.value = "";
  }, []);

  const handleSceneDataChange = useCallback((data: SceneData | null) => {
    setSceneData(data);
    if (!data) setScenesUrl(null);
  }, []);

  const handleLoadSceneData = useCallback(() => {
    sceneFileRef.current?.click();
  }, []);

  const handleLoadSceneFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string);
        const parsed = parseSceneData(json, sceneDataFpsRef.current);
        if (parsed) {
          setSceneData(parsed);
          setScenesUrl(null);
        }
      } catch {
        // Invalid JSON
      }
    };
    reader.readAsText(file);
  }, []);

  const handleModuleConfigChange = useCallback((next: PlayerModuleConfig) => {
    setModuleConfig(next);
    const settings = loadSettings();
    settings.moduleOverrides = next;
    saveSettings(settings);
  }, []);

  const sceneFileInput = (
    <input
      ref={sceneFileRef}
      type="file"
      accept=".json"
      style={{ display: "none" }}
      onChange={handleSceneFileChange}
    />
  );

  if (!src) {
    return (
      <div className="player-container">
        {sceneFileInput}
        <form
          className="url-form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get("url") as string;
            if (value?.trim()) setSrc(value.trim());
          }}
        >
          <input
            name="url"
            className="url-input"
            type="url"
            placeholder="Enter manifest URL (.mpd, .m3u8)"
            autoFocus
            required
          />
          <button type="submit" className="url-submit">
            Load
          </button>
          <button
            type="button"
            className="url-demo"
            onClick={() => setShowDemo(true)}
          >
            Demo
          </button>
        </form>
        <span className="url-version">
          v{__APP_VERSION__} ({__BUILD_DATE__}, {__BUILD_COMMIT__})
        </span>
        {showDemo && (
          <div className="demo-overlay" onClick={() => setShowDemo(false)}>
            <div className="demo-modal" onClick={(e) => e.stopPropagation()}>
              <div className="demo-header">
                <span className="demo-title">Demo Streams</span>
                <button
                  className="demo-close"
                  onClick={() => setShowDemo(false)}
                >
                  &times;
                </button>
              </div>
              <div className="demo-list">
                {DEMO_STREAMS.map((s) => (
                  <button
                    key={s.url}
                    className="demo-item"
                    onClick={() => {
                      setShowDemo(false);
                      setSrc(s.url);
                    }}
                  >
                    <span className="demo-item-name">{s.name}</span>
                    <span className="demo-item-desc">{s.description}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!moduleConfig || !deviceProfile) {
    return <div className="player-container">{sceneFileInput}</div>;
  }

  return (
    <div className="player-container">
      {sceneFileInput}
      <ShakaPlayer
        src={src}
        autoPlay
        clearKey={clearKey ?? undefined}
        startTime={startTime ?? undefined}
        compareSrc={compareSrc ?? undefined}
        compareQa={initial.compareQa ?? undefined}
        compareQb={initial.compareQb ?? undefined}
        compareZoom={initial.compareZoom ?? undefined}
        comparePx={initial.comparePx ?? undefined}
        comparePy={initial.comparePy ?? undefined}
        compareSplit={initial.compareSplit ?? undefined}
        compareHx={initial.compareHx ?? undefined}
        compareHy={initial.compareHy ?? undefined}
        compareHw={initial.compareHw ?? undefined}
        compareHh={initial.compareHh ?? undefined}
        compareCmode={initial.compareCmode ?? undefined}
        compareCfi={initial.compareCfi ?? undefined}
        compareAmp={initial.compareAmp ?? undefined}
        comparePal={initial.comparePal ?? undefined}
        compareVmodel={initial.compareVmodel ?? undefined}
        moduleConfig={moduleConfig}
        deviceProfile={deviceProfile}
        onModuleConfigChange={handleModuleConfigChange}
        sceneData={sceneData}
        onSceneDataChange={handleSceneDataChange}
        onLoadSceneData={handleLoadSceneData}
        onLoadSceneFile={handleLoadSceneFile}
        scenesUrl={scenesUrl}
      />
    </div>
  );
}

export default App;

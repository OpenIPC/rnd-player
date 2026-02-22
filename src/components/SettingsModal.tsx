import { createPortal } from "react-dom";
import { useState } from "react";
import { loadSettings, saveSettings } from "../hooks/useSettings";
import type { PlayerModuleConfig } from "../types/moduleConfig";
import type { DeviceProfile } from "../utils/detectCapabilities";

interface SettingsModalProps {
  onClose: () => void;
  moduleConfig: PlayerModuleConfig;
  deviceProfile: DeviceProfile;
  onModuleConfigChange: (config: PlayerModuleConfig) => void;
}

interface ModuleInfo {
  key: keyof PlayerModuleConfig;
  label: string;
  description: string;
  hardGate?: (profile: DeviceProfile) => string | null;
}

const MODULE_INFO: ModuleInfo[] = [
  {
    key: "filmstrip",
    label: "Filmstrip timeline",
    description: "Thumbnail timeline with GOP analysis and frame export",
    hardGate: (p) =>
      !p.webCodecs ? "Requires WebCodecs API" :
      !p.offscreenCanvas ? "Requires OffscreenCanvas API" : null,
  },
  {
    key: "qualityCompare",
    label: "Quality compare",
    description: "Side-by-side quality comparison with diff modes",
    hardGate: (p) =>
      !p.webCodecs ? "Requires WebCodecs API" :
      !p.webGL2 ? "Requires WebGL2" : null,
  },
  {
    key: "statsPanel",
    label: "Stats for nerds",
    description: "Real-time playback diagnostics overlay",
  },
  {
    key: "audioLevels",
    label: "Audio levels",
    description: "Real-time audio level meter",
    hardGate: (p) => !p.webAudio ? "Requires Web Audio API" : null,
  },
  {
    key: "segmentExport",
    label: "Segment export",
    description: "Export MP4 segments from in/out points",
    hardGate: (p) => !p.workers ? "Requires Web Workers" : null,
  },
  {
    key: "subtitles",
    label: "Subtitles",
    description: "Multi-track subtitle overlay with translation",
  },
  {
    key: "adaptationToast",
    label: "Adaptation toast",
    description: "ABR quality switch notifications",
  },
  {
    key: "keyboardShortcuts",
    label: "Keyboard shortcuts",
    description: "JKL shuttle, frame step, hotkeys",
  },
  {
    key: "sleepWakeRecovery",
    label: "Sleep/wake recovery",
    description: "Restore playback position after system sleep",
  },
];

export default function SettingsModal({
  onClose,
  moduleConfig,
  deviceProfile,
  onModuleConfigChange,
}: SettingsModalProps) {
  const [settings, setSettings] = useState(loadSettings);

  const toggle = (key: keyof typeof settings) => {
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    saveSettings(next);
  };

  const toggleModule = (key: keyof PlayerModuleConfig) => {
    const next = { ...moduleConfig, [key]: !moduleConfig[key] };
    onModuleConfigChange(next);
  };

  return createPortal(
    <div
      className="vp-help-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div className="vp-help-modal vp-settings-modal">
        <div className="vp-help-header">
          <h3 className="vp-help-title">Settings</h3>
          <button className="vp-help-close" onClick={onClose}>&times;</button>
        </div>
        <div className="vp-settings-body">
          <label className="vp-settings-row">
            <input
              type="checkbox"
              checked={settings.alwaysShowBitrate}
              onChange={() => toggle("alwaysShowBitrate")}
            />
            <span>Always show bitrate in quality selector</span>
          </label>

          <div className="vp-settings-section-title">Features</div>
          {MODULE_INFO.map((mod) => {
            const gateReason = mod.hardGate?.(deviceProfile) ?? null;
            const disabled = gateReason != null;
            return (
              <label key={mod.key} className={`vp-settings-row${disabled ? " vp-settings-disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={moduleConfig[mod.key]}
                  onChange={() => toggleModule(mod.key)}
                  disabled={disabled}
                />
                <span>
                  {mod.label}
                  <span className="vp-settings-desc">
                    {disabled ? gateReason : mod.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}

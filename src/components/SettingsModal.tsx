import { createPortal } from "react-dom";
import { useState } from "react";
import { loadSettings, saveSettings } from "../hooks/useSettings";

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState(loadSettings);

  const toggle = (key: keyof typeof settings) => {
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    saveSettings(next);
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
        </div>
      </div>
    </div>,
    document.body
  );
}

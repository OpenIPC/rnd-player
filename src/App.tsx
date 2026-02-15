import { useState } from "react";
import ShakaPlayer from "./components/ShakaPlayer";
import "./App.css";

function parseUrlParams(): {
  src: string | null;
  startTime: number | null;
  clearKey: string | null;
} {
  const params = new URLSearchParams(window.location.search);
  const v = params.get("v");
  const t = params.get("t");
  const key = params.get("key");

  return {
    src: v || null,
    startTime: t ? parseFloat(t.replace(/s$/, "")) || null : null,
    clearKey: key || null,
  };
}

const initial = parseUrlParams();

function App() {
  const [src, setSrc] = useState<string | null>(initial.src);
  const [clearKey] = useState<string | null>(initial.clearKey);
  const [startTime] = useState<number | null>(initial.startTime);

  if (!src) {
    return (
      <div className="player-container">
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
        </form>
      </div>
    );
  }

  return (
    <div className="player-container">
      <ShakaPlayer
        src={src}
        autoPlay
        clearKey={clearKey ?? undefined}
        startTime={startTime ?? undefined}
      />
    </div>
  );
}

export default App;

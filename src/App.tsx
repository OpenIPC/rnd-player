import { useState } from "react";
import ShakaPlayer from "./components/ShakaPlayer";
import "./App.css";

function App() {
  const [src, setSrc] = useState<string | null>(null);

  if (!src) {
    return (
      <div className="player-container">
        <h1>Vibe Player</h1>
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
      <h1>Vibe Player</h1>
      <ShakaPlayer src={src} autoPlay />
    </div>
  );
}

export default App;

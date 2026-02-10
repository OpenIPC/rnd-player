import ShakaPlayer from "./components/ShakaPlayer";
import "./App.css";

const DEMO_MANIFEST =
  "https://www.bok.net/dash/tears_of_steel/cleartext/stream.mpd";

function App() {
  return (
    <div className="player-container">
      <h1>Video Player</h1>
      <ShakaPlayer src={DEMO_MANIFEST} autoPlay />
    </div>
  );
}

export default App;

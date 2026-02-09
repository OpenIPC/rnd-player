import ShakaPlayer from "./components/ShakaPlayer";
import "./App.css";

const DEMO_MANIFEST =
  "https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd";

function App() {
  return (
    <div className="player-container">
      <h1>Video Player</h1>
      <ShakaPlayer src={DEMO_MANIFEST} autoPlay />
    </div>
  );
}

export default App;

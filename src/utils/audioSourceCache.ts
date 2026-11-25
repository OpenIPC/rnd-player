/** Shared AudioContext/MediaElementAudioSourceNode cache.
 *
 * `createMediaElementSource` throws if called twice on the same element.
 * Both `useAudioAnalyser` and `useLoudnessMeter` need access to the same
 * source node — this module provides a shared WeakMap so whoever connects
 * first creates it, and subsequent consumers reuse the existing entry.
 */

interface AudioSourceEntry {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  /** Whether `source.connect(context.destination)` has been called. */
  connectedToDestination: boolean;
}

const cache = new WeakMap<HTMLVideoElement, AudioSourceEntry>();

const GESTURE_EVENTS = ["pointerdown", "keydown", "touchend"] as const;

/**
 * Keep the context running whenever the element plays.
 *
 * Once an element is routed through `createMediaElementSource`, its audio is
 * pulled by the AudioContext — and while the context is "suspended" the
 * element's media clock does NOT advance: the video reports playing
 * (`paused=false`, `readyState=4`) but `currentTime` and decoded frames
 * freeze. The metering hooks create the context on mount, i.e. before any
 * user gesture, so under Chrome's autoplay policy it starts suspended and
 * the mount-time `resume()` is a no-op. Without a later resume, pressing
 * play froze the video (and in compare mode the slave sync loop then
 * ping-ponged the slave around the frozen master).
 *
 * Resume on the element's `play` event (covers click/keyboard/programmatic
 * play once the page has user activation) and on the first user gesture.
 */
function installAutoResume(context: AudioContext, videoEl: HTMLVideoElement): void {
  const resume = () => {
    if (context.state === "suspended") context.resume().catch(() => {});
  };
  // Listeners stay for the context's lifetime (cheap no-ops while running)
  // so a later suspend — e.g. a metering hook suspending on disable — also
  // recovers on the next play or gesture.
  videoEl.addEventListener("play", resume);
  for (const ev of GESTURE_EVENTS) document.addEventListener(ev, resume, true);
  context.addEventListener("statechange", () => {
    if (context.state !== "closed") return;
    videoEl.removeEventListener("play", resume);
    for (const ev of GESTURE_EVENTS) document.removeEventListener(ev, resume, true);
  });
}

export function getOrCreateAudioSource(videoEl: HTMLVideoElement): AudioSourceEntry {
  const existing = cache.get(videoEl);
  if (existing) return existing;

  const context = new AudioContext();
  const source = context.createMediaElementSource(videoEl);
  installAutoResume(context, videoEl);
  const entry: AudioSourceEntry = { context, source, connectedToDestination: false };
  cache.set(videoEl, entry);
  return entry;
}

/** Ensure the source is connected to the audio destination (speakers).
 *  Safe to call multiple times — only connects once. */
export function ensureDestinationConnected(entry: AudioSourceEntry): void {
  if (!entry.connectedToDestination) {
    entry.source.connect(entry.context.destination);
    entry.connectedToDestination = true;
  }
}

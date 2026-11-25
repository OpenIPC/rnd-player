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

/*
 * Auto-resume.
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
 * Each context is resumed on its element's `play` event (covers
 * click/keyboard/programmatic play once the page has user activation) and
 * on user gestures. Gesture listening is shared: ONE set of document
 * listeners walks a registry of live contexts. Entries whose element left
 * the DOM (player unmounted) or whose context closed are pruned, and the
 * document listeners are removed when the registry empties — so unmounted
 * players don't leave listeners pinning their context and element.
 */

const GESTURE_EVENTS = ["pointerdown", "keydown", "touchend"] as const;

interface ResumeEntry {
  context: AudioContext;
  videoEl: HTMLVideoElement;
}

const resumeRegistry = new Set<ResumeEntry>();
let gestureListenersInstalled = false;

function resumeIfSuspended(context: AudioContext): void {
  if (context.state === "suspended") context.resume().catch(() => {});
}

function isLive(entry: ResumeEntry): boolean {
  return entry.context.state !== "closed" && entry.videoEl.isConnected;
}

function setGestureListeners(install: boolean): void {
  if (install === gestureListenersInstalled) return;
  gestureListenersInstalled = install;
  for (const ev of GESTURE_EVENTS) {
    if (install) document.addEventListener(ev, onGesture, true);
    else document.removeEventListener(ev, onGesture, true);
  }
}

function onGesture(): void {
  for (const entry of resumeRegistry) {
    if (isLive(entry)) resumeIfSuspended(entry.context);
    else resumeRegistry.delete(entry);
  }
  if (resumeRegistry.size === 0) setGestureListeners(false);
}

function installAutoResume(context: AudioContext, videoEl: HTMLVideoElement): void {
  const entry: ResumeEntry = { context, videoEl };
  const onPlay = () => resumeIfSuspended(context);
  videoEl.addEventListener("play", onPlay);
  context.addEventListener("statechange", () => {
    if (context.state !== "closed") return;
    videoEl.removeEventListener("play", onPlay);
    resumeRegistry.delete(entry);
    if (resumeRegistry.size === 0) setGestureListeners(false);
  });
  resumeRegistry.add(entry);
  setGestureListeners(true);
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

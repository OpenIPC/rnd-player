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

export function getOrCreateAudioSource(videoEl: HTMLVideoElement): AudioSourceEntry {
  const existing = cache.get(videoEl);
  if (existing) return existing;

  const context = new AudioContext();
  const source = context.createMediaElementSource(videoEl);
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

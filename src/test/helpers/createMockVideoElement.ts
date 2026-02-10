import { vi } from "vitest";

export interface MockVideoElement extends Partial<HTMLVideoElement> {
  currentTime: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  buffered: TimeRanges;
  videoWidth: number;
  videoHeight: number;
  clientWidth: number;
  clientHeight: number;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  getVideoPlaybackQuality: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  _listeners: Map<string, Set<EventListener>>;
  _emit: (event: string) => void;
}

export function createMockVideoElement(
  overrides: Partial<MockVideoElement> = {}
): MockVideoElement {
  const listeners = new Map<string, Set<EventListener>>();

  const mock: MockVideoElement = {
    currentTime: 0,
    duration: 120,
    paused: true,
    volume: 1,
    muted: false,
    playbackRate: 1,
    videoWidth: 1920,
    videoHeight: 1080,
    clientWidth: 640,
    clientHeight: 360,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 30,
    } as TimeRanges,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    getVideoPlaybackQuality: vi.fn(() => ({
      totalVideoFrames: 1000,
      droppedVideoFrames: 2,
      creationTime: 0,
    })),
    addEventListener: vi.fn((event: string, handler: EventListener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: EventListener) => {
      listeners.get(event)?.delete(handler);
    }),
    _listeners: listeners,
    _emit(event: string) {
      listeners.get(event)?.forEach((fn) => fn(new Event(event)));
    },
    ...overrides,
  };

  return mock;
}

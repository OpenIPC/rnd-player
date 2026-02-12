import { vi } from "vitest";

export interface MockVariantTrack {
  id: number;
  active: boolean;
  width: number | null;
  height: number | null;
  bandwidth: number;
  frameRate: number | null;
  videoCodec: string;
  audioCodec: string;
  videoId: number | null;
  audioId: number | null;
  colorGamut: string | null;
  hdr: string | null;
  language: string;
  label: string;
  roles: string[];
}

export interface MockShakaPlayer {
  getVariantTracks: ReturnType<typeof vi.fn>;
  getTextTracks: ReturnType<typeof vi.fn>;
  getStats: ReturnType<typeof vi.fn>;
  getBufferedInfo: ReturnType<typeof vi.fn>;
  getAssetUri: ReturnType<typeof vi.fn>;
  getManifestType: ReturnType<typeof vi.fn>;
  configure: ReturnType<typeof vi.fn>;
  selectVariantTrack: ReturnType<typeof vi.fn>;
  getAudioTracks: ReturnType<typeof vi.fn>;
  selectAudioTrack: ReturnType<typeof vi.fn>;
  selectTextTrack: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  _listeners: Map<string, Set<EventListener>>;
  _emit: (event: string) => void;
}

export function createDefaultTrack(
  overrides: Partial<MockVariantTrack> = {}
): MockVariantTrack {
  return {
    id: 1,
    active: true,
    width: 1920,
    height: 1080,
    bandwidth: 5000000,
    frameRate: 30,
    videoCodec: "avc1.4d401f",
    audioCodec: "mp4a.40.2",
    videoId: 1,
    audioId: 1,
    colorGamut: null,
    hdr: null,
    language: "en",
    label: "English",
    roles: [],
    ...overrides,
  };
}

export function createMockShakaPlayer(
  overrides: Partial<MockShakaPlayer> = {}
): MockShakaPlayer {
  const listeners = new Map<string, Set<EventListener>>();

  const mock: MockShakaPlayer = {
    getVariantTracks: vi.fn(() => [createDefaultTrack()]),
    getTextTracks: vi.fn(() => []),
    getStats: vi.fn(() => ({
      estimatedBandwidth: 5000000,
      streamBandwidth: 3000000,
      loadLatency: 0.5,
      playTime: 10,
      pauseTime: 2,
      bufferingTime: 0.5,
      liveLatency: 0,
      droppedFrames: 1,
      decodedFrames: 500,
      stallsDetected: 0,
      gapsJumped: 0,
      bytesDownloaded: 1048576,
      manifestSizeBytes: 2048,
    })),
    getBufferedInfo: vi.fn(() => ({
      total: [{ start: 0, end: 30 }],
    })),
    getAssetUri: vi.fn(() => "https://example.com/manifest.mpd"),
    getManifestType: vi.fn(() => "DASH"),
    configure: vi.fn(),
    selectVariantTrack: vi.fn(),
    getAudioTracks: vi.fn(() => []),
    selectAudioTrack: vi.fn(),
    selectTextTrack: vi.fn(),
    attach: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(() => Promise.resolve()),
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

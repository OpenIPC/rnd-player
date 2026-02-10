import { vi } from "vitest";

function MockPlayer() {
  return {
    attach: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(() => Promise.resolve()),
    configure: vi.fn(),
    getVariantTracks: vi.fn(() => []),
    selectVariantTrack: vi.fn(),
    getStats: vi.fn(() => ({})),
    getBufferedInfo: vi.fn(() => ({ total: [] })),
    getAssetUri: vi.fn(() => ""),
    getManifestType: vi.fn(() => ""),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

const Player = vi.fn().mockImplementation(MockPlayer) as ReturnType<typeof vi.fn> & {
  isBrowserSupported: ReturnType<typeof vi.fn>;
};
Player.isBrowserSupported = vi.fn(() => true);

const shaka = {
  Player,
  polyfill: {
    installAll: vi.fn(),
  },
  util: {
    Error: class ShakaError extends Error {
      code: number;
      constructor(_severity: number, _category: number, code: number) {
        super(`Shaka Error ${code}`);
        this.code = code;
      }
    },
  },
};

export default shaka;

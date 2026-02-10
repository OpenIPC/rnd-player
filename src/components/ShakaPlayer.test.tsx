import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import ShakaPlayer from "./ShakaPlayer";
import shaka from "shaka-player";

vi.mock("shaka-player");

// Mock VideoControls to avoid needing the full mock chain
vi.mock("./VideoControls", () => ({
  default: () => <div data-testid="video-controls">VideoControls</div>,
}));

describe("ShakaPlayer", () => {
  let mockPlayerInstance: {
    attach: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    getVariantTracks: ReturnType<typeof vi.fn>;
    selectVariantTrack: ReturnType<typeof vi.fn>;
    getStats: ReturnType<typeof vi.fn>;
    getBufferedInfo: ReturnType<typeof vi.fn>;
    getAssetUri: ReturnType<typeof vi.fn>;
    getManifestType: ReturnType<typeof vi.fn>;
    configure: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockPlayerInstance = {
      attach: vi.fn(() => Promise.resolve()),
      load: vi.fn(() => Promise.resolve()),
      destroy: vi.fn(() => Promise.resolve()),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getVariantTracks: vi.fn(() => []),
      selectVariantTrack: vi.fn(),
      getStats: vi.fn(() => ({})),
      getBufferedInfo: vi.fn(() => ({ total: [] })),
      getAssetUri: vi.fn(() => ""),
      getManifestType: vi.fn(() => ""),
      configure: vi.fn(),
    };

    (shaka.Player as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function () { return mockPlayerInstance; }
    );
    (shaka.Player.isBrowserSupported as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it("installs polyfills and attaches player", async () => {
    render(<ShakaPlayer src="https://example.com/manifest.mpd" />);

    expect(shaka.polyfill.installAll).toHaveBeenCalled();
    expect(shaka.Player).toHaveBeenCalled();

    await waitFor(() => {
      expect(mockPlayerInstance.attach).toHaveBeenCalled();
    });
  });

  it("loads the manifest from src prop", async () => {
    render(<ShakaPlayer src="https://example.com/manifest.mpd" />);

    await waitFor(() => {
      expect(mockPlayerInstance.load).toHaveBeenCalledWith(
        "https://example.com/manifest.mpd"
      );
    });
  });

  it("renders VideoControls after player is ready", async () => {
    render(<ShakaPlayer src="https://example.com/manifest.mpd" />);

    await waitFor(() => {
      expect(screen.getByTestId("video-controls")).toBeInTheDocument();
    });
  });

  it("renders a video element", () => {
    render(<ShakaPlayer src="https://example.com/manifest.mpd" />);

    const video = document.querySelector("video");
    expect(video).toBeInTheDocument();
  });

  it("sets autoPlay attribute when prop is true", () => {
    render(
      <ShakaPlayer src="https://example.com/manifest.mpd" autoPlay />
    );

    const video = document.querySelector("video");
    expect(video).toHaveAttribute("autoplay");
  });

  it("destroys player on unmount", async () => {
    const { unmount } = render(
      <ShakaPlayer src="https://example.com/manifest.mpd" />
    );

    await waitFor(() => {
      expect(mockPlayerInstance.load).toHaveBeenCalled();
    });

    unmount();

    expect(mockPlayerInstance.destroy).toHaveBeenCalled();
  });

  it("does not render if browser is unsupported", () => {
    (shaka.Player.isBrowserSupported as ReturnType<typeof vi.fn>).mockReturnValue(false);

    render(<ShakaPlayer src="https://example.com/manifest.mpd" />);

    // VideoControls should not render
    expect(screen.queryByTestId("video-controls")).not.toBeInTheDocument();
  });
});

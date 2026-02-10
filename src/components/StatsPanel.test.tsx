import { render, screen, act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import StatsPanel from "./StatsPanel";
import { createMockVideoElement } from "../test/helpers/createMockVideoElement";
import { createMockShakaPlayer } from "../test/helpers/createMockShakaPlayer";

vi.mock("shaka-player");

function setup(
  videoOverrides?: Parameters<typeof createMockVideoElement>[0],
  playerOverrides?: Parameters<typeof createMockShakaPlayer>[0]
) {
  const videoEl = createMockVideoElement(videoOverrides);
  const player = createMockShakaPlayer(playerOverrides);
  const onClose = vi.fn();

  const result = render(
    <StatsPanel
      player={player as unknown as import("shaka-player").default.Player}
      videoEl={videoEl as unknown as HTMLVideoElement}
      onClose={onClose}
    />
  );

  return { videoEl, player, onClose, ...result };
}

describe("StatsPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders stat rows from player/video data", () => {
    setup();
    expect(screen.getByText("Manifest")).toBeInTheDocument();
    expect(screen.getByText("Viewport / Frames")).toBeInTheDocument();
    expect(screen.getByText("Current / Optimal Res")).toBeInTheDocument();
    expect(screen.getByText("Connection Speed")).toBeInTheDocument();
    expect(screen.getByText("Buffer Health")).toBeInTheDocument();
  });

  it("displays DASH manifest type", () => {
    setup();
    expect(screen.getByText(/DASH/)).toBeInTheDocument();
  });

  it("displays codec information", () => {
    setup();
    expect(screen.getByText(/avc1/)).toBeInTheDocument();
    expect(screen.getByText(/mp4a/)).toBeInTheDocument();
  });

  it("close button calls onClose", () => {
    const { onClose } = setup();

    const closeBtn = screen.getByText("×");
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledOnce();
  });

  describe("polling updates", () => {
    it("updates stats on interval", () => {
      const { player } = setup();

      const initialCallCount = player.getStats.mock.calls.length;

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(player.getStats.mock.calls.length).toBeGreaterThan(
        initialCallCount
      );
    });
  });

  describe("cleanup on unmount", () => {
    it("clears interval on unmount", () => {
      const { player, unmount } = setup();

      unmount();

      const callCountAtUnmount = player.getStats.mock.calls.length;

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      // No more calls after unmount
      expect(player.getStats.mock.calls.length).toBe(callCountAtUnmount);
    });
  });

  describe("PlaybackQuality fallback", () => {
    it("falls back to shaka stats when getVideoPlaybackQuality unavailable", () => {
      setup({
        getVideoPlaybackQuality: undefined as unknown as ReturnType<
          typeof vi.fn
        >,
      });

      // Should still render frame stats without crashing
      expect(screen.getByText(/dropped of/)).toBeInTheDocument();
    });
  });

  describe("regressions", () => {
    it("[cab5911] NaN from PlaybackQuality displays as 0", () => {
      setup({
        getVideoPlaybackQuality: vi.fn(() => ({
          totalVideoFrames: NaN,
          droppedVideoFrames: NaN,
          creationTime: 0,
        })),
      });

      // Should display "0 dropped of 0" instead of NaN
      expect(screen.getByText(/0 dropped of 0/)).toBeInTheDocument();
    });
  });
});

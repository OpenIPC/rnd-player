import { render, screen, act, fireEvent } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import VideoControls from "./VideoControls";
import {
  createMockVideoElement,
  type MockVideoElement,
} from "../test/helpers/createMockVideoElement";
import {
  createMockShakaPlayer,
  createDefaultTrack,
  type MockShakaPlayer,
} from "../test/helpers/createMockShakaPlayer";

vi.mock("shaka-player");

function setup(
  videoOverrides?: Partial<MockVideoElement>,
  playerOverrides?: Partial<MockShakaPlayer>
) {
  const videoEl = createMockVideoElement(videoOverrides);
  const containerEl = document.createElement("div");
  containerEl.addEventListener = vi.fn();
  containerEl.removeEventListener = vi.fn();
  const player = createMockShakaPlayer(playerOverrides);

  const result = render(
    <VideoControls
      videoEl={videoEl as unknown as HTMLVideoElement}
      containerEl={containerEl}
      player={player as unknown as import("shaka-player").default.Player}
    />
  );

  return { videoEl, containerEl, player, ...result };
}

describe("VideoControls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("play/pause", () => {
    it("renders play icon when video is paused", () => {
      setup({ paused: true });
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThan(0);
    });

    it("calls videoEl.play() when clicking play button while paused", () => {
      const { videoEl } = setup({ paused: true });

      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]);

      expect(videoEl.play).toHaveBeenCalled();
    });

    it("calls videoEl.pause() when clicking pause button while playing", () => {
      const { videoEl } = setup({ paused: false });

      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[0]);

      expect(videoEl.pause).toHaveBeenCalled();
    });
  });

  describe("time display", () => {
    it("displays formatted current time and duration", () => {
      setup({ currentTime: 65, duration: 3661 });
      expect(screen.getByText(/1:05/)).toBeInTheDocument();
      expect(screen.getByText(/1:01:01/)).toBeInTheDocument();
    });
  });

  describe("quality selector", () => {
    it("opens quality popup on click", () => {
      const tracks = [
        createDefaultTrack({ id: 1, height: 1080, bandwidth: 5000000 }),
        createDefaultTrack({
          id: 2,
          height: 720,
          bandwidth: 3000000,
          active: false,
        }),
      ];
      setup({}, { getVariantTracks: vi.fn(() => tracks) });

      const qualityBtn = screen.getByText("1080p").closest("button")!;
      fireEvent.click(qualityBtn);

      expect(screen.getByText("Quality")).toBeInTheDocument();
      expect(screen.getByText("720p")).toBeInTheDocument();
    });

    it("selecting a quality calls player.selectVariantTrack", () => {
      const tracks = [
        createDefaultTrack({ id: 1, height: 1080, bandwidth: 5000000 }),
        createDefaultTrack({
          id: 2,
          height: 720,
          bandwidth: 3000000,
          active: false,
        }),
      ];
      const { player } = setup(
        {},
        { getVariantTracks: vi.fn(() => tracks) }
      );

      // Open quality popup
      const qualityBtn = screen.getByText("1080p").closest("button")!;
      fireEvent.click(qualityBtn);

      // Select 720p
      fireEvent.click(screen.getByText("720p"));

      expect(player.configure).toHaveBeenCalledWith("abr.enabled", false);
      expect(player.selectVariantTrack).toHaveBeenCalled();
    });
  });

  describe("speed selector", () => {
    it("changes playbackRate on speed selection", () => {
      const { videoEl } = setup();

      // Find speed button (shows "1x" label)
      const speedBtn = screen.getByText("1x").closest("button")!;
      fireEvent.click(speedBtn);

      expect(screen.getByText("Speed")).toBeInTheDocument();

      // Click 2x speed
      fireEvent.click(screen.getByText("2x"));

      expect(videoEl.playbackRate).toBe(2);
    });
  });

  describe("auto-hide controls", () => {
    it("hides controls after HIDE_DELAY when playing", () => {
      setup({ paused: false });

      const wrapper = document.querySelector(".vp-controls-wrapper");
      expect(wrapper).not.toHaveClass("vp-hidden");

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(wrapper).toHaveClass("vp-hidden");
    });

    it("stays visible when paused", () => {
      setup({ paused: true });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      const wrapper = document.querySelector(".vp-controls-wrapper");
      expect(wrapper).not.toHaveClass("vp-hidden");
    });
  });

  describe("event listener cleanup", () => {
    it("removes video event listeners on unmount", () => {
      const { videoEl, unmount } = setup();
      unmount();

      const removedEvents = (videoEl.removeEventListener as Mock).mock.calls.map(
        (c: unknown[]) => c[0]
      );
      expect(removedEvents).toContain("play");
      expect(removedEvents).toContain("pause");
      expect(removedEvents).toContain("timeupdate");
      expect(removedEvents).toContain("durationchange");
      expect(removedEvents).toContain("volumechange");
      expect(removedEvents).toContain("ratechange");
      expect(removedEvents).toContain("progress");
    });

    it("removes shaka event listeners on unmount", () => {
      const { player, unmount } = setup();
      unmount();

      const removedEvents = (player.removeEventListener as Mock).mock.calls.map(
        (c: unknown[]) => c[0]
      );
      expect(removedEvents).toContain("trackschanged");
      expect(removedEvents).toContain("variantchanged");
      expect(removedEvents).toContain("adaptation");
    });
  });

  describe("regressions", () => {
    it("[089ae02] auto quality label updates during ABR adaptation", () => {
      const track720 = createDefaultTrack({
        id: 2,
        height: 720,
        bandwidth: 3000000,
        active: true,
      });
      const track1080 = createDefaultTrack({
        id: 1,
        height: 1080,
        bandwidth: 5000000,
        active: false,
      });

      const player = createMockShakaPlayer({
        getVariantTracks: vi.fn(() => [track1080, track720]),
      });

      const videoEl = createMockVideoElement();
      const containerEl = document.createElement("div");
      containerEl.addEventListener = vi.fn();
      containerEl.removeEventListener = vi.fn();

      render(
        <VideoControls
          videoEl={videoEl as unknown as HTMLVideoElement}
          containerEl={containerEl}
          player={
            player as unknown as import("shaka-player").default.Player
          }
        />
      );

      // Initially shows 720p (the active track)
      expect(screen.getByText("720p")).toBeInTheDocument();

      // Simulate ABR adaptation: 1080p becomes active
      const updatedTracks = [
        createDefaultTrack({
          id: 1,
          height: 1080,
          bandwidth: 5000000,
          active: true,
        }),
        createDefaultTrack({
          id: 2,
          height: 720,
          bandwidth: 3000000,
          active: false,
        }),
      ];
      (player.getVariantTracks as Mock).mockReturnValue(updatedTracks);

      // Trigger the adaptation event
      act(() => {
        player._emit("adaptation");
      });

      // Label should update to 1080p
      expect(screen.getByText("1080p")).toBeInTheDocument();
    });
  });
});

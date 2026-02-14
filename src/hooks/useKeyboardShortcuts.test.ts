import { renderHook, act } from "@testing-library/react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

function createMockVideoEl() {
  return {
    currentTime: 10,
    duration: 100,
    paused: false,
    muted: false,
    volume: 0.8,
    playbackRate: 1,
    play: vi.fn(),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLVideoElement;
}

function createMockContainerEl() {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLDivElement;
}

function fireKey(key: string, target?: HTMLElement) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  if (target) {
    Object.defineProperty(event, "target", { value: target });
  }
  document.dispatchEvent(event);
}

describe("useKeyboardShortcuts", () => {
  let videoEl: ReturnType<typeof createMockVideoEl>;
  let containerEl: ReturnType<typeof createMockContainerEl>;
  let onTogglePlay: ReturnType<typeof vi.fn>;
  let onToggleMute: ReturnType<typeof vi.fn>;
  let onToggleFullscreen: ReturnType<typeof vi.fn>;
  let onInPointSet: ReturnType<typeof vi.fn>;
  let onOutPointSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    videoEl = createMockVideoEl();
    containerEl = createMockContainerEl();
    onTogglePlay = vi.fn();
    onToggleMute = vi.fn();
    onToggleFullscreen = vi.fn();
    onInPointSet = vi.fn();
    onOutPointSet = vi.fn();
  });

  function renderShortcuts() {
    return renderHook(() =>
      useKeyboardShortcuts({
        videoEl: videoEl as unknown as HTMLVideoElement,
        containerEl: containerEl as unknown as HTMLDivElement,
        fps: 30,
        onTogglePlay,
        onToggleMute,
        onToggleFullscreen,
        onInPointSet,
        onOutPointSet,
      }),
    );
  }

  it("returns initial shuttle state", () => {
    const { result } = renderShortcuts();
    expect(result.current.shuttleSpeed).toBe(0);
    expect(result.current.shuttleDirection).toBe(0);
  });

  it("toggles play on Space", () => {
    renderShortcuts();
    act(() => fireKey(" "));
    expect(onTogglePlay).toHaveBeenCalled();
  });

  it("pauses on K", () => {
    renderShortcuts();
    act(() => fireKey("k"));
    expect(videoEl.pause).toHaveBeenCalled();
  });

  it("shuttles forward on L", () => {
    const { result } = renderShortcuts();
    act(() => fireKey("l"));
    expect(result.current.shuttleDirection).toBe(1);
    expect(result.current.shuttleSpeed).toBe(1);
    expect(videoEl.play).toHaveBeenCalled();
  });

  it("increases forward shuttle speed on repeated L", () => {
    const { result } = renderShortcuts();
    act(() => fireKey("l"));
    act(() => fireKey("l"));
    expect(result.current.shuttleSpeed).toBe(2);
    expect(videoEl.playbackRate).toBe(2);
  });

  it("shuttles reverse on J", () => {
    const { result } = renderShortcuts();
    act(() => fireKey("j"));
    expect(result.current.shuttleDirection).toBe(-1);
    expect(result.current.shuttleSpeed).toBe(1);
    expect(videoEl.pause).toHaveBeenCalled();
  });

  it("steps frame forward on ArrowRight", () => {
    renderShortcuts();
    act(() => fireKey("ArrowRight"));
    expect(videoEl.pause).toHaveBeenCalled();
    // 10 + 1/30
    expect(videoEl.currentTime).toBeCloseTo(10 + 1 / 30);
  });

  it("steps frame backward on ArrowLeft", () => {
    renderShortcuts();
    act(() => fireKey("ArrowLeft"));
    expect(videoEl.pause).toHaveBeenCalled();
    expect(videoEl.currentTime).toBeCloseTo(10 - 1 / 30);
  });

  it("steps frame forward on period", () => {
    renderShortcuts();
    act(() => fireKey("."));
    expect(videoEl.currentTime).toBeCloseTo(10 + 1 / 30);
  });

  it("steps frame backward on comma", () => {
    renderShortcuts();
    act(() => fireKey(","));
    expect(videoEl.currentTime).toBeCloseTo(10 - 1 / 30);
  });

  it("increases volume on ArrowUp", () => {
    renderShortcuts();
    act(() => fireKey("ArrowUp"));
    expect(videoEl.volume).toBeCloseTo(0.85);
  });

  it("decreases volume on ArrowDown", () => {
    renderShortcuts();
    act(() => fireKey("ArrowDown"));
    expect(videoEl.volume).toBeCloseTo(0.75);
  });

  it("seeks to start on Home", () => {
    renderShortcuts();
    act(() => fireKey("Home"));
    expect(videoEl.currentTime).toBe(0);
  });

  it("seeks to end on End", () => {
    renderShortcuts();
    act(() => fireKey("End"));
    expect(videoEl.currentTime).toBe(100);
  });

  it("sets in-point on I", () => {
    renderShortcuts();
    act(() => fireKey("i"));
    expect(onInPointSet).toHaveBeenCalledWith(10);
  });

  it("sets out-point on O", () => {
    renderShortcuts();
    act(() => fireKey("o"));
    expect(onOutPointSet).toHaveBeenCalledWith(10);
  });

  it("toggles mute on M", () => {
    renderShortcuts();
    act(() => fireKey("m"));
    expect(onToggleMute).toHaveBeenCalled();
  });

  it("toggles fullscreen on F", () => {
    renderShortcuts();
    act(() => fireKey("f"));
    expect(onToggleFullscreen).toHaveBeenCalled();
  });

  it("ignores keys when target is an input", () => {
    renderShortcuts();
    const input = document.createElement("input");
    act(() => fireKey(" ", input));
    expect(onTogglePlay).not.toHaveBeenCalled();
  });
});

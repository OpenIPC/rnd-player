import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

class FakeAudioContext extends EventTarget {
  state: AudioContextState = "suspended";
  resume = vi.fn(async () => { this.state = "running"; this.dispatchEvent(new Event("statechange")); });
  createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }));
  destination = {};
  close() { this.state = "closed"; this.dispatchEvent(new Event("statechange")); }
}

let created: FakeAudioContext[];
beforeEach(() => {
  created = [];
  vi.stubGlobal("AudioContext", class extends FakeAudioContext { constructor() { super(); created.push(this); } });
});
afterEach(() => vi.unstubAllGlobals());

describe("getOrCreateAudioSource auto-resume", () => {
  it("resumes a suspended context when the element plays (frozen-clock bug)", async () => {
    const { getOrCreateAudioSource } = await import("./audioSourceCache");
    const video = document.createElement("video");
    getOrCreateAudioSource(video);
    const ctx = created[0];
    expect(ctx.state).toBe("suspended");
    video.dispatchEvent(new Event("play"));
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe("running");
  });

  it("resumes on the first user gesture, and again after a later suspend", async () => {
    const { getOrCreateAudioSource } = await import("./audioSourceCache");
    const video = document.createElement("video");
    getOrCreateAudioSource(video);
    const ctx = created[0];
    document.dispatchEvent(new Event("pointerdown"));
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    ctx.state = "suspended"; // e.g. a metering hook suspended it
    video.dispatchEvent(new Event("play"));
    expect(ctx.resume).toHaveBeenCalledTimes(2);
  });

  it("does not resume when running, and detaches once closed", async () => {
    const { getOrCreateAudioSource } = await import("./audioSourceCache");
    const video = document.createElement("video");
    getOrCreateAudioSource(video);
    const ctx = created[0];
    ctx.state = "running";
    video.dispatchEvent(new Event("play"));
    expect(ctx.resume).not.toHaveBeenCalled();
    ctx.close();
    video.dispatchEvent(new Event("play"));
    document.dispatchEvent(new Event("keydown"));
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("reuses the cached entry per element", async () => {
    const { getOrCreateAudioSource } = await import("./audioSourceCache");
    const video = document.createElement("video");
    expect(getOrCreateAudioSource(video)).toBe(getOrCreateAudioSource(video));
    expect(created).toHaveLength(1);
  });
});

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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules(); // fresh registry per test
  document.body.innerHTML = "";
});

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
    document.body.appendChild(video);
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
    document.body.appendChild(video);
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

  it("drops unmounted players from gesture resume and removes document listeners (review #1)", async () => {
    const { getOrCreateAudioSource } = await import("./audioSourceCache");
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const a = document.createElement("video");
    const b = document.createElement("video");
    document.body.append(a, b);
    getOrCreateAudioSource(a);
    getOrCreateAudioSource(b);
    const [ctxA, ctxB] = created;
    // Shared listeners: installed once, not per context
    const installs = add.mock.calls.filter(([t]) => t === "pointerdown");
    expect(installs).toHaveLength(1);
    const handler = installs[0][1];

    a.remove(); // player A unmounted
    document.dispatchEvent(new Event("pointerdown"));
    expect(ctxA.resume).not.toHaveBeenCalled();
    expect(ctxB.resume).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalledWith("pointerdown", handler, true);

    b.remove(); // last player unmounted → listeners removed on next gesture
    document.dispatchEvent(new Event("pointerdown"));
    expect(remove).toHaveBeenCalledWith("pointerdown", handler, true);
  });
});

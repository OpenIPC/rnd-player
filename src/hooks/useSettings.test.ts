import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSettings, saveSettings, type PlayerSettings } from "./useSettings";

// Node 25+ has a built-in `localStorage` that overrides jsdom's.
// Mock it to avoid incompatibility.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
});

beforeEach(() => {
  store.clear();
});

describe("loadSettings", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual({ alwaysShowBitrate: false, moduleOverrides: {} });
  });

  it("returns stored values", () => {
    store.set("vp_settings", JSON.stringify({ alwaysShowBitrate: true }));
    expect(loadSettings()).toEqual({ alwaysShowBitrate: true, moduleOverrides: {} });
  });

  it("merges partial stored values with defaults", () => {
    store.set("vp_settings", JSON.stringify({}));
    expect(loadSettings()).toEqual({ alwaysShowBitrate: false, moduleOverrides: {} });
  });

  it("returns defaults for corrupt JSON", () => {
    store.set("vp_settings", "not json");
    expect(loadSettings()).toEqual({ alwaysShowBitrate: false, moduleOverrides: {} });
  });
});

describe("saveSettings", () => {
  it("persists settings to localStorage", () => {
    const settings: PlayerSettings = { alwaysShowBitrate: true, moduleOverrides: {} };
    saveSettings(settings);
    expect(JSON.parse(store.get("vp_settings")!)).toEqual(settings);
  });

  it("round-trips correctly", () => {
    const settings: PlayerSettings = { alwaysShowBitrate: true, moduleOverrides: {} };
    saveSettings(settings);
    expect(loadSettings()).toEqual(settings);
  });
});

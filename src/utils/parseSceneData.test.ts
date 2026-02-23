import { describe, it, expect } from "vitest";
import { parseSceneData } from "./parseSceneData";

const validJson = {
  frames: 1500,
  scenes: [
    { start_frame: 0, end_frame: 240, zone_overrides: null },
    { start_frame: 240, end_frame: 500, zone_overrides: null },
    { start_frame: 500, end_frame: 1000, zone_overrides: null },
    { start_frame: 1000, end_frame: 1500, zone_overrides: null },
  ],
};

describe("parseSceneData", () => {
  it("parses valid JSON at 30 fps", () => {
    const result = parseSceneData(validJson, 30);
    expect(result).not.toBeNull();
    expect(result!.totalFrames).toBe(1500);
    expect(result!.fps).toBe(30);
    expect(result!.ptsOffset).toBe(0);
    // Boundaries: 240/30=8, 500/30=16.667, 1000/30=33.333
    expect(result!.boundaries).toHaveLength(3);
    expect(result!.boundaries[0]).toBeCloseTo(8, 5);
    expect(result!.boundaries[1]).toBeCloseTo(500 / 30, 5);
    expect(result!.boundaries[2]).toBeCloseTo(1000 / 30, 5);
  });

  it("parses valid JSON at 24 fps", () => {
    const result = parseSceneData(validJson, 24);
    expect(result).not.toBeNull();
    expect(result!.fps).toBe(24);
    expect(result!.boundaries[0]).toBeCloseTo(240 / 24, 5);
    expect(result!.boundaries[1]).toBeCloseTo(500 / 24, 5);
    expect(result!.boundaries[2]).toBeCloseTo(1000 / 24, 5);
  });

  it("excludes frame 0 from boundaries", () => {
    const result = parseSceneData(validJson, 30);
    expect(result).not.toBeNull();
    // Frame 0 should not appear as a boundary
    expect(result!.boundaries.every((b) => b > 0)).toBe(true);
  });

  it("deduplicates boundaries", () => {
    const duped = {
      frames: 100,
      scenes: [
        { start_frame: 0, end_frame: 50, zone_overrides: null },
        { start_frame: 50, end_frame: 50, zone_overrides: null },
        { start_frame: 50, end_frame: 100, zone_overrides: null },
      ],
    };
    const result = parseSceneData(duped, 30);
    expect(result).not.toBeNull();
    expect(result!.boundaries).toHaveLength(1);
    expect(result!.boundaries[0]).toBeCloseTo(50 / 30, 5);
  });

  it("returns null for invalid JSON (not an object)", () => {
    expect(parseSceneData("string", 30)).toBeNull();
    expect(parseSceneData(42, 30)).toBeNull();
    expect(parseSceneData(null, 30)).toBeNull();
    expect(parseSceneData(undefined, 30)).toBeNull();
  });

  it("returns null for missing frames field", () => {
    expect(parseSceneData({ scenes: [] }, 30)).toBeNull();
  });

  it("returns null for missing scenes field", () => {
    expect(parseSceneData({ frames: 100 }, 30)).toBeNull();
  });

  it("returns null for empty scenes array", () => {
    expect(parseSceneData({ frames: 100, scenes: [] }, 30)).toBeNull();
  });

  it("returns null for scenes with invalid frame numbers", () => {
    const invalid = {
      frames: 100,
      scenes: [{ start_frame: "abc", end_frame: 50, zone_overrides: null }],
    };
    expect(parseSceneData(invalid, 30)).toBeNull();
  });

  it("returns null for fps <= 0", () => {
    expect(parseSceneData(validJson, 0)).toBeNull();
    expect(parseSceneData(validJson, -1)).toBeNull();
  });

  it("returns null for non-finite fps", () => {
    expect(parseSceneData(validJson, NaN)).toBeNull();
    expect(parseSceneData(validJson, Infinity)).toBeNull();
  });

  it("sorts boundaries in ascending order", () => {
    const unordered = {
      frames: 200,
      scenes: [
        { start_frame: 100, end_frame: 200, zone_overrides: null },
        { start_frame: 0, end_frame: 50, zone_overrides: null },
        { start_frame: 50, end_frame: 100, zone_overrides: null },
      ],
    };
    const result = parseSceneData(unordered, 30);
    expect(result).not.toBeNull();
    expect(result!.boundaries).toHaveLength(2);
    expect(result!.boundaries[0]).toBeLessThan(result!.boundaries[1]);
  });
});

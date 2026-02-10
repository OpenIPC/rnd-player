import { safeNum } from "./safeNum";

describe("safeNum", () => {
  it("returns valid numbers as-is", () => {
    expect(safeNum(42)).toBe(42);
    expect(safeNum(3.14)).toBe(3.14);
  });

  it("returns 0 for NaN", () => {
    expect(safeNum(NaN)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(safeNum(undefined)).toBe(0);
  });

  it("preserves zero", () => {
    expect(safeNum(0)).toBe(0);
  });

  it("preserves negative numbers", () => {
    expect(safeNum(-5)).toBe(-5);
  });

  describe("regressions", () => {
    it("[cab5911] NaN from PlaybackQuality displayed instead of 0", () => {
      // PlaybackQuality API can return NaN for frame counts
      expect(safeNum(NaN)).toBe(0);
      expect(safeNum(undefined)).toBe(0);
    });
  });
});

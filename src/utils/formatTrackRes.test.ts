import { formatTrackRes } from "./formatTrackRes";

describe("formatTrackRes", () => {
  it("formats width, height, and fps", () => {
    expect(formatTrackRes(1920, 1080, 30)).toBe("1920×1080@30");
  });

  it("formats without fps when null", () => {
    expect(formatTrackRes(1280, 720, null)).toBe("1280×720");
  });

  it("returns N/A for null width", () => {
    expect(formatTrackRes(null, 1080, 30)).toBe("N/A");
  });

  it("returns N/A for null height", () => {
    expect(formatTrackRes(1920, null, 30)).toBe("N/A");
  });

  it("returns N/A for both null", () => {
    expect(formatTrackRes(null, null, null)).toBe("N/A");
  });

  it("rounds fractional fps", () => {
    expect(formatTrackRes(1920, 1080, 29.97)).toBe("1920×1080@30");
    expect(formatTrackRes(1920, 1080, 23.976)).toBe("1920×1080@24");
  });
});

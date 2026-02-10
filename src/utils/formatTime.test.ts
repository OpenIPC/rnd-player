import { formatTime } from "./formatTime";

describe("formatTime", () => {
  it("formats 0 seconds", () => {
    expect(formatTime(0)).toBe("0:00");
  });

  it("formats sub-minute values", () => {
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(45)).toBe("0:45");
  });

  it("formats minutes", () => {
    expect(formatTime(60)).toBe("1:00");
    expect(formatTime(90)).toBe("1:30");
    expect(formatTime(605)).toBe("10:05");
  });

  it("formats hours", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(3661)).toBe("1:01:01");
    expect(formatTime(7265)).toBe("2:01:05");
  });

  it("zero-pads minutes when hours present", () => {
    expect(formatTime(3605)).toBe("1:00:05");
  });

  it("truncates fractional seconds", () => {
    expect(formatTime(65.9)).toBe("1:05");
    expect(formatTime(0.5)).toBe("0:00");
  });
});

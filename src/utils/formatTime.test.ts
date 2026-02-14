import { formatTime, formatTimecode } from "./formatTime";

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

describe("formatTimecode", () => {
  describe("milliseconds mode", () => {
    it("formats zero", () => {
      expect(formatTimecode(0, "milliseconds")).toBe("0:00:00.000");
    });

    it("formats fractional seconds", () => {
      expect(formatTimecode(65.32, "milliseconds")).toBe("0:01:05.320");
    });

    it("formats hours", () => {
      expect(formatTimecode(3661.5, "milliseconds")).toBe("1:01:01.500");
    });

    it("pads minutes and seconds but not hours", () => {
      expect(formatTimecode(1.001, "milliseconds")).toBe("0:00:01.001");
      expect(formatTimecode(8585.0, "milliseconds")).toBe("2:23:05.000");
    });
  });

  describe("frames mode", () => {
    it("formats zero at 30fps", () => {
      expect(formatTimecode(0, "frames", 30)).toBe("0:00:00:00");
    });

    it("formats fractional seconds at 30fps", () => {
      // 65.32 => frames = floor(0.32 * 30) = floor(9.6) = 9
      expect(formatTimecode(65.32, "frames", 30)).toBe("0:01:05:09");
    });

    it("formats at 24fps", () => {
      // 0.5 * 24 = 12
      expect(formatTimecode(60.5, "frames", 24)).toBe("0:01:00:12");
    });

    it("defaults to 30fps when fps omitted", () => {
      // 0.5 * 30 = 15
      expect(formatTimecode(0.5, "frames")).toBe("0:00:00:15");
    });

    it("uses colon separator per SMPTE convention", () => {
      const result = formatTimecode(1.0, "frames", 30);
      expect(result).toBe("0:00:01:00");
      expect(result).not.toContain(".");
    });

    it("does not pad hours", () => {
      // 2h 23m 58s + 17 frames at 30fps => 17/30 = 0.5667
      expect(formatTimecode(8638.567, "frames", 30)).toBe("2:23:58:17");
    });
  });

  describe("totalFrames mode", () => {
    it("formats zero", () => {
      expect(formatTimecode(0, "totalFrames", 30)).toBe("0");
    });

    it("returns absolute frame number at 30fps", () => {
      // 65.32 * 30 = 1959.6 => floor = 1959
      expect(formatTimecode(65.32, "totalFrames", 30)).toBe("1959");
    });

    it("returns absolute frame number at 24fps", () => {
      // 60.5 * 24 = 1452
      expect(formatTimecode(60.5, "totalFrames", 24)).toBe("1452");
    });

    it("handles large values", () => {
      // 8638.567 * 30 = 259157.01 => floor = 259157
      expect(formatTimecode(8638.567, "totalFrames", 30)).toBe("259157");
    });
  });
});

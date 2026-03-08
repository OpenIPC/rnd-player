import { describe, it, expect } from "vitest";
import { validateTimelines } from "./timelineValidator";

function makeSegments(
  count: number,
  duration: number,
  startOffset = 0,
): { startTime: number; endTime: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    startTime: startOffset + i * duration,
    endTime: startOffset + (i + 1) * duration,
  }));
}

describe("timelineValidator", () => {
  it("returns no issues for a clean timeline", () => {
    const issues = validateTimelines([
      {
        label: "video 1920x1080",
        type: "video",
        segments: makeSegments(10, 2),
      },
      {
        label: "audio 48kHz",
        type: "audio",
        segments: makeSegments(10, 2),
      },
    ]);
    expect(issues).toHaveLength(0);
  });

  it("TL-001: detects gap between segments", () => {
    const segments = makeSegments(5, 2);
    // Insert a 200ms gap between segments 2 and 3
    segments[3] = { startTime: 6.2, endTime: 8.2 };
    segments[4] = { startTime: 8.2, endTime: 10.2 };

    const issues = validateTimelines([
      { label: "video 1080p", type: "video", segments },
    ]);
    const gaps = issues.filter((i) => i.id === "TL-001");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].message).toContain("Gap");
    expect(gaps[0].message).toContain("200ms");
  });

  it("TL-002: detects overlap between segments", () => {
    const segments = makeSegments(5, 2);
    // Overlap: segment 2 ends at 6 but segment 3 starts at 5.9
    segments[3] = { startTime: 5.9, endTime: 7.9 };
    segments[4] = { startTime: 7.9, endTime: 9.9 };

    const issues = validateTimelines([
      { label: "video 1080p", type: "video", segments },
    ]);
    const overlaps = issues.filter((i) => i.id === "TL-002");
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].message).toContain("Overlap");
  });

  it("TL-003: detects duration variance", () => {
    const segments = [
      { startTime: 0, endTime: 2 },
      { startTime: 2, endTime: 4 },
      { startTime: 4, endTime: 6 },
      { startTime: 6, endTime: 12 }, // 6s vs mean ~2.5s → >50% above
      { startTime: 12, endTime: 14 },
    ];

    const issues = validateTimelines([
      { label: "video 1080p", type: "video", segments },
    ]);
    const variance = issues.filter((i) => i.id === "TL-003");
    expect(variance.length).toBeGreaterThanOrEqual(1);
    expect(variance[0].message).toContain("Segment 3");
  });

  it("TL-003: ignores last segment (often shorter)", () => {
    const segments = [
      { startTime: 0, endTime: 4 },
      { startTime: 4, endTime: 8 },
      { startTime: 8, endTime: 12 },
      { startTime: 12, endTime: 13 }, // Last segment, short but expected
    ];

    const issues = validateTimelines([
      { label: "video 1080p", type: "video", segments },
    ]);
    const variance = issues.filter((i) => i.id === "TL-003");
    expect(variance).toHaveLength(0);
  });

  it("TL-005: detects duration mismatch across video representations", () => {
    const issues = validateTimelines([
      {
        label: "video 864x486",
        type: "video",
        segments: makeSegments(128, 3.175), // ~406.4s
      },
      {
        label: "video 1280x720",
        type: "video",
        segments: makeSegments(127, 3.183), // ~404.2s
      },
      {
        label: "video 1920x1080",
        type: "video",
        segments: makeSegments(127, 3.183), // ~404.2s
      },
    ]);
    const mismatch = issues.filter((i) => i.id === "TL-005");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].severity).toBe("error"); // >2s difference
    expect(mismatch[0].detail).toContain("video 864x486");
    expect(mismatch[0].detail).toContain("video 1280x720");
  });

  it("TL-005: no issue when video durations match", () => {
    const issues = validateTimelines([
      {
        label: "video 720p",
        type: "video",
        segments: makeSegments(100, 2),
      },
      {
        label: "video 1080p",
        type: "video",
        segments: makeSegments(100, 2),
      },
    ]);
    const mismatch = issues.filter((i) => i.id === "TL-005");
    expect(mismatch).toHaveLength(0);
  });

  it("TL-005: detects audio/video duration mismatch >2s", () => {
    const issues = validateTimelines([
      {
        label: "video 1080p",
        type: "video",
        segments: makeSegments(127, 3.183), // ~404.2s
      },
      {
        label: "audio 48kHz",
        type: "audio",
        segments: makeSegments(204, 1.992), // ~406.4s
      },
    ]);
    // Difference is ~2.16s → should trigger warning
    const mismatch = issues.filter(
      (i) => i.id === "TL-005" && i.message.includes("Audio/video"),
    );
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].severity).toBe("warning");
  });

  it("TL-006: detects misaligned audio/video boundaries with same segment duration", () => {
    // Same segment duration (2s) but offset by 0.5s — genuinely misaligned
    const videoSegs = makeSegments(10, 2);
    const audioSegs = makeSegments(10, 2, 0.5); // offset by 500ms
    const issues = validateTimelines([
      { label: "video 1080p", type: "video", segments: videoSegs },
      { label: "audio 48kHz", type: "audio", segments: audioSegs },
    ]);
    const misaligned = issues.filter((i) => i.id === "TL-006");
    expect(misaligned).toHaveLength(1);
  });

  it("TL-006: no warning when audio/video have different segment durations", () => {
    // Different segment durations (3s video / 2s audio) — expected for ISM/DASH
    const issues = validateTimelines([
      { label: "video 1080p", type: "video", segments: makeSegments(10, 3) },
      { label: "audio 48kHz", type: "audio", segments: makeSegments(15, 2) },
    ]);
    const misaligned = issues.filter((i) => i.id === "TL-006");
    expect(misaligned).toHaveLength(0);
  });

  it("handles empty timelines gracefully", () => {
    const issues = validateTimelines([]);
    expect(issues).toHaveLength(0);
  });

  it("handles single-segment timeline", () => {
    const issues = validateTimelines([
      {
        label: "video 1080p",
        type: "video",
        segments: [{ startTime: 0, endTime: 10 }],
      },
    ]);
    expect(issues).toHaveLength(0);
  });

  describe("ISM-like multi-track scenario (CDP pattern)", () => {
    // Models the real CDP bug: 5 video reps in 2 duration groups + 2 audio tracks
    // SD video (486p, 576p): 128 segments x ~3.175s = ~406.4s
    // HD video (720p, 900p, 1080p): 127 segments x ~3.183s = ~404.2s
    // Audio: 204 segments x ~1.992s = ~406.4s (different segment grid)

    function makeIsmTimelines() {
      return validateTimelines([
        { label: "video 864x486", type: "video", segments: makeSegments(128, 3.175) },
        { label: "video 1024x576", type: "video", segments: makeSegments(128, 3.175) },
        { label: "video 1280x720", type: "video", segments: makeSegments(127, 3.183) },
        { label: "video 1600x900", type: "video", segments: makeSegments(127, 3.183) },
        { label: "video 1920x1080", type: "video", segments: makeSegments(127, 3.183) },
        { label: "audio 48kHz", type: "audio", segments: makeSegments(204, 1.992) },
        { label: "audio 48kHz", type: "audio", segments: makeSegments(204, 1.992) },
      ]);
    }

    it("TL-005: detects video duration mismatch between SD and HD groups", () => {
      const issues = makeIsmTimelines();
      const videoMismatch = issues.filter(
        (i) => i.id === "TL-005" && !i.message.includes("Audio"),
      );
      expect(videoMismatch).toHaveLength(1);
      expect(videoMismatch[0].severity).toBe("error"); // >2s difference
      // Groups should be reported with their labels
      expect(videoMismatch[0].detail).toContain("video 864x486");
      expect(videoMismatch[0].detail).toContain("video 1280x720");
    });

    it("TL-005: no audio/video mismatch when first video matches audio duration", () => {
      const issues = makeIsmTimelines();
      // First video is SD (406.4s), audio is also ~406.4s → within threshold
      const avMismatch = issues.filter(
        (i) => i.id === "TL-005" && i.message.includes("Audio"),
      );
      expect(avMismatch).toHaveLength(0);
    });

    it("TL-006: no false positive with different audio/video segment durations", () => {
      const issues = makeIsmTimelines();
      // Video ~3.18s segments, audio ~1.99s → ratio 1.6 > 1.1 → alignment check skipped
      expect(issues.filter((i) => i.id === "TL-006")).toHaveLength(0);
    });

    it("TL-005: audio/video mismatch detected when HD track listed first", () => {
      // If manifest lists HD first, the audio vs first-video comparison catches the gap
      const issues = validateTimelines([
        { label: "video 1280x720", type: "video", segments: makeSegments(127, 3.183) },
        { label: "video 864x486", type: "video", segments: makeSegments(128, 3.175) },
        { label: "audio 48kHz", type: "audio", segments: makeSegments(204, 1.992) },
      ]);
      const avMismatch = issues.filter(
        (i) => i.id === "TL-005" && i.message.includes("Audio"),
      );
      expect(avMismatch).toHaveLength(1);
      expect(avMismatch[0].severity).toBe("warning");
    });
  });

  it("TL-005: warning severity for small mismatch (0.5-2s)", () => {
    const issues = validateTimelines([
      {
        label: "video 720p",
        type: "video",
        segments: makeSegments(100, 2), // 200s
      },
      {
        label: "video 1080p",
        type: "video",
        segments: makeSegments(100, 2.01), // 201s — 1s diff
      },
    ]);
    const mismatch = issues.filter((i) => i.id === "TL-005");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].severity).toBe("warning");
  });
});

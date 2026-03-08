import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock mp4box with controllable parse results
const mockMp4 = {
  appendBuffer: vi.fn(),
  flush: vi.fn(),
  moov: null as unknown,
};
vi.mock("mp4box", () => ({
  createFile: () => mockMp4,
}));

import { validateCodecs } from "./codecValidator";

// --- Helpers ---

interface CodecStreamInfo {
  label: string;
  type: "video" | "audio";
  codecs: string;
  encrypted: boolean;
  manifestType: string;
  initSegmentUrl: string | null;
}

function makeStream(overrides: Partial<CodecStreamInfo> = {}): CodecStreamInfo {
  return {
    label: "video 1920x1080",
    type: "video",
    codecs: "avc1.640028",
    encrypted: false,
    manifestType: "DASH",
    initSegmentUrl: "http://test/init.mp4",
    ...overrides,
  };
}

function makeTrak(opts: {
  trackId?: number;
  handler?: string;
  sampleType?: string;
  sinf?: unknown;
}) {
  const entry: Record<string, unknown> = { type: opts.sampleType ?? "avc1" };
  if (opts.sinf) entry.sinf = opts.sinf;
  return {
    tkhd: { track_id: opts.trackId ?? 1 },
    mdia: {
      hdlr: { handler_type: opts.handler ?? "vide" },
      minf: {
        stbl: {
          stsd: {
            entries: [entry],
          },
        },
      },
    },
  };
}

/** Minimal valid ArrayBuffer (content doesn't matter — mp4box is mocked) */
function dummyInitSegment(): ArrayBuffer {
  return new Uint8Array(16).buffer;
}

describe("codecValidator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMp4.moov = {
      traks: [makeTrak({ sampleType: "avc1", handler: "vide" })],
    };
  });

  it("returns no issues when codec matches sample entry", async () => {
    const issues = await validateCodecs(
      [makeStream({ codecs: "avc1.640028" })],
      async () => dummyInitSegment(),
    );
    expect(issues).toHaveLength(0);
  });

  it("CS-003: detects codec mismatch", async () => {
    // Manifest says hev1, init segment has avc1
    const issues = await validateCodecs(
      [makeStream({ codecs: "hev1.1.6.L93.B0" })],
      async () => dummyInitSegment(),
    );
    const mismatch = issues.filter((i) => i.id === "CS-003");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].severity).toBe("error");
    expect(mismatch[0].message).toContain("hev1");
    expect(mismatch[0].message).toContain("avc1");
  });

  it("CS-003: accepts equivalent codec pairs (avc1/avc3)", async () => {
    // Manifest says avc3, init segment has avc1 — equivalent
    mockMp4.moov = { traks: [makeTrak({ sampleType: "avc3" })] };
    const issues = await validateCodecs(
      [makeStream({ codecs: "avc1.640028" })],
      async () => dummyInitSegment(),
    );
    expect(issues.filter((i) => i.id === "CS-003")).toHaveLength(0);
  });

  it("CS-003: accepts equivalent codec pairs (hvc1/hev1)", async () => {
    mockMp4.moov = { traks: [makeTrak({ sampleType: "hev1" })] };
    const issues = await validateCodecs(
      [makeStream({ codecs: "hvc1.1.6.L93.B0", manifestType: "DASH" })],
      async () => dummyInitSegment(),
    );
    expect(issues.filter((i) => i.id === "CS-003")).toHaveLength(0);
  });

  describe("encrypted content (ISM CDP pattern)", () => {
    it("CS-003: resolves codec through encv → sinf → frma", async () => {
      // ISM encrypted: stsd has "encv" wrapper, real codec in sinf.frma
      mockMp4.moov = {
        traks: [
          makeTrak({
            sampleType: "encv",
            handler: "vide",
            sinf: {
              frma: { data_format: "avc1" },
              schm: { scheme_type: "cenc" },
              schi: { tenc: {} },
            },
          }),
        ],
      };
      const issues = await validateCodecs(
        [makeStream({ codecs: "avc1.640028", encrypted: true })],
        async () => dummyInitSegment(),
      );
      expect(issues.filter((i) => i.id === "CS-003")).toHaveLength(0);
    });

    it("CS-003: detects mismatch even through encv wrapper", async () => {
      mockMp4.moov = {
        traks: [
          makeTrak({
            sampleType: "encv",
            handler: "vide",
            sinf: { frma: { data_format: "hev1" } },
          }),
        ],
      };
      const issues = await validateCodecs(
        [makeStream({ codecs: "avc1.640028", encrypted: true })],
        async () => dummyInitSegment(),
      );
      const mismatch = issues.filter((i) => i.id === "CS-003");
      expect(mismatch).toHaveLength(1);
    });

    it("CS-007: detects missing sinf on encrypted sample entry", async () => {
      mockMp4.moov = {
        traks: [makeTrak({ sampleType: "encv", handler: "vide" })],
      };
      const issues = await validateCodecs(
        [makeStream({ codecs: "avc1.640028", encrypted: true })],
        async () => dummyInitSegment(),
      );
      const sinf = issues.filter((i) => i.id === "CS-007");
      expect(sinf).toHaveLength(1);
      expect(sinf[0].severity).toBe("error");
      expect(sinf[0].specRef).toContain("ISO");
    });

    it("CS-007: no issue when sinf is present", async () => {
      mockMp4.moov = {
        traks: [
          makeTrak({
            sampleType: "encv",
            handler: "vide",
            sinf: { frma: { data_format: "avc1" } },
          }),
        ],
      };
      const issues = await validateCodecs(
        [makeStream({ codecs: "avc1.640028", encrypted: true })],
        async () => dummyInitSegment(),
      );
      expect(issues.filter((i) => i.id === "CS-007")).toHaveLength(0);
    });
  });

  describe("HLS-specific checks", () => {
    it("CS-001: flags hev1 codec in HLS", async () => {
      mockMp4.moov = { traks: [makeTrak({ sampleType: "hev1", handler: "vide" })] };
      const issues = await validateCodecs(
        [makeStream({ codecs: "hev1.1.6.L93.B0", manifestType: "HLS" })],
        async () => dummyInitSegment(),
      );
      const hls = issues.filter((i) => i.id === "CS-001");
      expect(hls).toHaveLength(1);
      expect(hls[0].severity).toBe("error");
      expect(hls[0].message).toContain("hvc1");
    });

    it("CS-001: no issue for hvc1 in HLS", async () => {
      mockMp4.moov = { traks: [makeTrak({ sampleType: "hvc1", handler: "vide" })] };
      const issues = await validateCodecs(
        [makeStream({ codecs: "hvc1.1.6.L93.B0", manifestType: "HLS" })],
        async () => dummyInitSegment(),
      );
      expect(issues.filter((i) => i.id === "CS-001")).toHaveLength(0);
    });

    it("CS-001: no issue for hev1 in DASH", async () => {
      mockMp4.moov = { traks: [makeTrak({ sampleType: "hev1", handler: "vide" })] };
      const issues = await validateCodecs(
        [makeStream({ codecs: "hev1.1.6.L93.B0", manifestType: "DASH" })],
        async () => dummyInitSegment(),
      );
      expect(issues.filter((i) => i.id === "CS-001")).toHaveLength(0);
    });
  });

  it("audio codec: mp4a matches mp4a sample entry", async () => {
    mockMp4.moov = { traks: [makeTrak({ sampleType: "mp4a", handler: "soun" })] };
    const issues = await validateCodecs(
      [makeStream({ type: "audio", label: "audio 48kHz", codecs: "mp4a.40.2" })],
      async () => dummyInitSegment(),
    );
    expect(issues.filter((i) => i.id === "CS-003")).toHaveLength(0);
  });

  it("audio codec: enca wrapper with sinf.frma for encrypted audio", async () => {
    mockMp4.moov = {
      traks: [
        makeTrak({
          sampleType: "enca",
          handler: "soun",
          sinf: { frma: { data_format: "mp4a" } },
        }),
      ],
    };
    const issues = await validateCodecs(
      [makeStream({ type: "audio", label: "audio 48kHz", codecs: "mp4a.40.2", encrypted: true })],
      async () => dummyInitSegment(),
    );
    expect(issues.filter((i) => i.id === "CS-003")).toHaveLength(0);
  });

  it("skips streams without init segment URL", async () => {
    const fetchFn = vi.fn();
    const issues = await validateCodecs(
      [makeStream({ initSegmentUrl: null })],
      fetchFn,
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(issues).toHaveLength(0);
  });

  it("deduplicates fetches for streams sharing init URL", async () => {
    mockMp4.moov = {
      traks: [
        makeTrak({ trackId: 1, sampleType: "avc1", handler: "vide" }),
        makeTrak({ trackId: 2, sampleType: "mp4a", handler: "soun" }),
      ],
    };
    const fetchFn = vi.fn().mockResolvedValue(dummyInitSegment());
    await validateCodecs(
      [
        makeStream({ codecs: "avc1.640028", initSegmentUrl: "http://test/init.mp4" }),
        makeStream({ type: "audio", label: "audio 48kHz", codecs: "mp4a.40.2", initSegmentUrl: "http://test/init.mp4" }),
      ],
      fetchFn,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("gracefully handles fetch failure", async () => {
    const issues = await validateCodecs(
      [makeStream()],
      async () => { throw new Error("Network error"); },
    );
    // codecValidator silently skips fetch failures (BMFF validator reports them)
    expect(issues).toHaveLength(0);
  });
});

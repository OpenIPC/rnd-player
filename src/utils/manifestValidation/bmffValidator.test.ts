import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock shaka-player (imported at module level by bmffValidator)
vi.mock("shaka-player");

// Mock cencDecrypt — extractTenc/extractScheme navigate mp4box tree
const mockExtractTenc = vi.fn().mockReturnValue(null);
const mockExtractScheme = vi.fn().mockReturnValue(null);
vi.mock("../../workers/cencDecrypt", () => ({
  extractTenc: (...args: unknown[]) => mockExtractTenc(...args),
  extractScheme: (...args: unknown[]) => mockExtractScheme(...args),
}));

// Mock mp4box
const mockMp4 = {
  appendBuffer: vi.fn(),
  flush: vi.fn(),
  moov: null as unknown,
  ftyp: null as unknown,
};
vi.mock("mp4box", () => ({
  createFile: () => mockMp4,
}));

import { validateBmff } from "./bmffValidator";

// --- Binary helpers ---

/** Encode a 4-char string as bytes */
function s4(str: string): number[] {
  return [
    str.charCodeAt(0),
    str.charCodeAt(1),
    str.charCodeAt(2),
    str.charCodeAt(3),
  ];
}

/** Big-endian uint32 */
function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** Build a minimal ftyp box followed by padding to reach ≥8 bytes */
function makeFtypBytes(brand = "isom"): ArrayBuffer {
  // ftyp: [size:4]["ftyp":4][major_brand:4][minor_version:4][compatible:4]
  const data = [...u32(24), ...s4("ftyp"), ...s4(brand), ...u32(0), ...s4(brand)];
  return new Uint8Array(data).buffer;
}

/** Build bytes with a non-ftyp first box */
function makeNonFtypBytes(): ArrayBuffer {
  const data = [...u32(16), ...s4("moov"), ...u32(0), ...u32(0)];
  return new Uint8Array(data).buffer;
}

/** Build a tiny (<8 bytes) buffer */
function makeTinyBytes(): ArrayBuffer {
  return new Uint8Array([0, 0, 0, 4]).buffer;
}

// --- Stream factory ---

interface StreamInfo {
  id: number;
  type: "video" | "audio";
  label: string;
  codecs: string;
  encrypted: boolean;
  drmScheme?: string;
  initSegmentUrl: string | null;
}

function makeStream(overrides: Partial<StreamInfo> = {}): StreamInfo {
  return {
    id: 1,
    type: "video",
    label: "video 1920x1080",
    codecs: "avc1.640028",
    encrypted: false,
    initSegmentUrl: "http://test/init.mp4",
    ...overrides,
  };
}

describe("bmffValidator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mp4 mock to default valid state
    mockMp4.moov = {
      traks: [{ tkhd: { track_id: 1 } }],
      mvex: {},
    };
    mockMp4.ftyp = {
      major_brand: "isom",
      compatible_brands: ["isom", "iso2", "dash"],
    };
    mockExtractTenc.mockReturnValue(null);
    mockExtractScheme.mockReturnValue(null);
  });

  it("returns no issues for a valid init segment", async () => {
    const issues = await validateBmff(
      [makeStream()],
      async () => makeFtypBytes(),
    );
    expect(issues).toHaveLength(0);
  });

  it("BMFF-001: detects non-ftyp first box", async () => {
    const issues = await validateBmff(
      [makeStream()],
      async () => makeNonFtypBytes(),
    );
    const ftyp = issues.filter((i) => i.id === "BMFF-001");
    expect(ftyp).toHaveLength(1);
    expect(ftyp[0].severity).toBe("error");
    expect(ftyp[0].message).toContain("moov");
  });

  it("BMFF-ERR: reports init segment too small", async () => {
    const issues = await validateBmff(
      [makeStream()],
      async () => makeTinyBytes(),
    );
    const err = issues.filter((i) => i.id === "BMFF-ERR");
    expect(err).toHaveLength(1);
    expect(err[0].message).toContain("too small");
  });

  it("BMFF-ERR: reports fetch failure", async () => {
    const issues = await validateBmff(
      [makeStream()],
      async () => { throw new Error("Network error"); },
    );
    const err = issues.filter((i) => i.id === "BMFF-ERR");
    expect(err).toHaveLength(1);
    expect(err[0].message).toContain("Failed to fetch");
  });

  it("BMFF-002: detects missing moov box", async () => {
    mockMp4.moov = null;
    const issues = await validateBmff(
      [makeStream()],
      async () => makeFtypBytes(),
    );
    const moov = issues.filter((i) => i.id === "BMFF-002");
    expect(moov).toHaveLength(1);
    expect(moov[0].severity).toBe("error");
  });

  it("BMFF-003: detects missing mvex box", async () => {
    mockMp4.moov = { traks: [{ tkhd: { track_id: 1 } }], mvex: null };
    const issues = await validateBmff(
      [makeStream()],
      async () => makeFtypBytes(),
    );
    const mvex = issues.filter((i) => i.id === "BMFF-003");
    expect(mvex).toHaveLength(1);
    expect(mvex[0].severity).toBe("error");
    expect(mvex[0].specRef).toContain("MSE");
  });

  it("BMFF-007: reports uncommon ftyp brands", async () => {
    mockMp4.ftyp = {
      major_brand: "isom",
      compatible_brands: ["isom", "xbrd"],
    };
    const issues = await validateBmff(
      [makeStream()],
      async () => makeFtypBytes(),
    );
    const brand = issues.filter((i) => i.id === "BMFF-007");
    expect(brand).toHaveLength(1);
    expect(brand[0].severity).toBe("info");
    expect(brand[0].message).toContain("xbrd");
  });

  it("BMFF-007: piff brand is known (ISM/Smooth Streaming)", async () => {
    mockMp4.ftyp = {
      major_brand: "isom",
      compatible_brands: ["isom", "piff"],
    };
    const issues = await validateBmff(
      [makeStream()],
      async () => makeFtypBytes(),
    );
    expect(issues.filter((i) => i.id === "BMFF-007")).toHaveLength(0);
  });

  it("BMFF-007: deduplicates brand issues across tracks sharing init URL", async () => {
    mockMp4.moov = {
      traks: [
        { tkhd: { track_id: 1 } },
        { tkhd: { track_id: 2 } },
      ],
      mvex: {},
    };
    mockMp4.ftyp = {
      major_brand: "zzzz",
      compatible_brands: ["zzzz"],
    };
    const issues = await validateBmff(
      [
        makeStream({ id: 1, label: "video 720p", initSegmentUrl: "http://test/init-v.mp4" }),
        makeStream({ id: 2, label: "video 1080p", initSegmentUrl: "http://test/init-v.mp4" }),
      ],
      async () => makeFtypBytes(),
    );
    // Both tracks share init URL → single grouped BMFF-007
    const brand = issues.filter((i) => i.id === "BMFF-007");
    expect(brand).toHaveLength(1);
    expect(brand[0].detail).toContain("video 720p");
  });

  describe("encryption metadata (ISM CDP pattern)", () => {
    // ISM content: tenc with non-zero KID present but content served clear

    it("BMFF-011: warns about encryption metadata on clear content", async () => {
      mockExtractTenc.mockReturnValue({
        defaultPerSampleIVSize: 0,
        defaultKID: new Uint8Array([
          0x86, 0xac, 0x5e, 0xf2, 0x80, 0x93, 0x36, 0x0b,
          0xbc, 0x3c, 0x4a, 0x73, 0x8c, 0xba, 0x03, 0xfd,
        ]),
        defaultConstantIV: null,
      });
      mockExtractScheme.mockReturnValue("cbcs");

      const issues = await validateBmff(
        [makeStream({ encrypted: false })],
        async () => makeFtypBytes(),
      );
      const enc = issues.filter((i) => i.id === "BMFF-011");
      expect(enc).toHaveLength(1);
      expect(enc[0].severity).toBe("warning");
      expect(enc[0].message).toContain("Encryption metadata on clear content");
      expect(enc[0].detail).toContain("cbcs");
    });

    it("BMFF-011: no warning when stream is reported as encrypted", async () => {
      mockExtractTenc.mockReturnValue({
        defaultPerSampleIVSize: 8,
        defaultKID: new Uint8Array([
          0x86, 0xac, 0x5e, 0xf2, 0x80, 0x93, 0x36, 0x0b,
          0xbc, 0x3c, 0x4a, 0x73, 0x8c, 0xba, 0x03, 0xfd,
        ]),
        defaultConstantIV: null,
      });
      mockExtractScheme.mockReturnValue("cbcs");

      const issues = await validateBmff(
        [makeStream({ encrypted: true })],
        async () => makeFtypBytes(),
      );
      expect(issues.filter((i) => i.id === "BMFF-011")).toHaveLength(0);
    });

    it("BMFF-011: no warning when KID is all zeros", async () => {
      mockExtractTenc.mockReturnValue({
        defaultPerSampleIVSize: 0,
        defaultKID: new Uint8Array(16), // all zeros
        defaultConstantIV: null,
      });

      const issues = await validateBmff(
        [makeStream({ encrypted: false })],
        async () => makeFtypBytes(),
      );
      // All-zero KID → isNonZeroKid = false → no BMFF-011
      expect(issues.filter((i) => i.id === "BMFF-011")).toHaveLength(0);
    });

    it("BMFF-009: detects unknown encryption scheme", async () => {
      mockExtractScheme.mockReturnValue("xenc");

      const issues = await validateBmff(
        [makeStream({ encrypted: true })],
        async () => makeFtypBytes(),
      );
      const scheme = issues.filter((i) => i.id === "BMFF-009");
      expect(scheme).toHaveLength(1);
      expect(scheme[0].severity).toBe("error");
      expect(scheme[0].message).toContain("xenc");
    });

    it("BMFF-009: accepts cenc and cbcs schemes", async () => {
      for (const s of ["cenc", "cbcs", "cens", "cbc1"]) {
        mockExtractScheme.mockReturnValue(s);
        const issues = await validateBmff(
          [makeStream({ encrypted: true })],
          async () => makeFtypBytes(),
        );
        expect(
          issues.filter((i) => i.id === "BMFF-009"),
          `scheme "${s}" should be accepted`,
        ).toHaveLength(0);
      }
    });
  });

  it("skips streams without init segment URL", async () => {
    const fetchFn = vi.fn();
    const issues = await validateBmff(
      [makeStream({ initSegmentUrl: null })],
      fetchFn,
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(issues).toHaveLength(0);
  });

  it("deduplicates fetches for streams sharing init URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeFtypBytes());
    await validateBmff(
      [
        makeStream({ id: 1, label: "video 720p", initSegmentUrl: "http://test/init.mp4" }),
        makeStream({ id: 2, label: "video 1080p", initSegmentUrl: "http://test/init.mp4" }),
      ],
      fetchFn,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

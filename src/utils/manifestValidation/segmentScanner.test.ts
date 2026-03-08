import { describe, it, expect, vi } from "vitest";
import {
  scanSegments,
  parseTrun,
  parseMfhd,
  parseTfdt,
  parseTfhdDefaultSize,
} from "./segmentScanner";
import type { ScanTrack, SegmentFetchResult } from "./segmentScanner";

// --- Binary builders for synthetic BMFF segments ---

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function s4(str: string): number[] {
  return [str.charCodeAt(0), str.charCodeAt(1), str.charCodeAt(2), str.charCodeAt(3)];
}

/** Build a box: [size:4][type:4][payload] */
function box(type: string, payload: number[]): number[] {
  return [...u32(8 + payload.length), ...s4(type), ...payload];
}

/** Build a full box: [size:4][type:4][version:1][flags:3][payload] */
function fullBox(type: string, version: number, flags: number, payload: number[]): number[] {
  return [
    ...u32(12 + payload.length),
    ...s4(type),
    version,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff,
    ...payload,
  ];
}

/** Build a trun box with per-sample sizes */
function makeTrun(
  samples: Array<{ size: number; duration?: number }>,
  opts?: { dataOffset?: number },
): number[] {
  let flags = 0x200; // sample_size_present
  const hasDuration = samples.some((s) => s.duration !== undefined);
  if (hasDuration) flags |= 0x100;
  if (opts?.dataOffset !== undefined) flags |= 0x1;

  const payload: number[] = [...u32(samples.length)];
  if (opts?.dataOffset !== undefined) payload.push(...u32(opts.dataOffset));

  for (const s of samples) {
    if (hasDuration) payload.push(...u32(s.duration ?? 0));
    payload.push(...u32(s.size));
  }

  return fullBox("trun", 0, flags, payload);
}

/** Build an mfhd box with sequence number */
function makeMfhd(sequenceNumber: number): number[] {
  return fullBox("mfhd", 0, 0, u32(sequenceNumber));
}

/** Build a tfhd box with optional default_sample_size */
function makeTfhd(trackId: number, defaultSize?: number): number[] {
  let flags = 0;
  const payload = [...u32(trackId)];
  if (defaultSize !== undefined) {
    flags |= 0x10;
    payload.push(...u32(defaultSize));
  }
  return fullBox("tfhd", 0, flags, payload);
}

/** Build a tfdt box with base media decode time */
function makeTfdt(baseDecodeTime: number, version = 0): number[] {
  if (version === 1) {
    // 64-bit
    const hi = Math.floor(baseDecodeTime / 0x100000000);
    const lo = baseDecodeTime >>> 0;
    return fullBox("tfdt", 1, 0, [...u32(hi), ...u32(lo)]);
  }
  return fullBox("tfdt", 0, 0, u32(baseDecodeTime));
}

/**
 * Build a senc box with per-sample sub-sample entries.
 * ivSize=0 → no per-sample IVs (CDP CBCS clear pattern).
 */
function makeSenc(
  samples: Array<{ subsamples: Array<{ clear: number; encrypted: number }> }>,
  ivSize = 0,
): number[] {
  const flags = 0x2; // sub-sample info present
  const payload: number[] = [...u32(samples.length)];

  for (const sample of samples) {
    // Per-sample IV (ivSize bytes)
    for (let i = 0; i < ivSize; i++) payload.push(0);
    // Sub-sample count
    payload.push(...u16(sample.subsamples.length));
    for (const ss of sample.subsamples) {
      payload.push(...u16(ss.clear)); // clear_bytes (uint16)
      payload.push(...u32(ss.encrypted)); // encrypted_bytes (uint32)
    }
  }

  return fullBox("senc", 0, flags, payload);
}

/** Build a complete moof box containing mfhd + traf(tfhd + tfdt + trun + senc) */
function makeMoof(opts: {
  sequenceNumber: number;
  trackId: number;
  baseDecodeTime: number;
  samples: Array<{ size: number }>;
  sencSamples?: Array<{ subsamples: Array<{ clear: number; encrypted: number }> }>;
  ivSize?: number;
  defaultSampleSize?: number;
}): Uint8Array {
  const trafChildren: number[] = [
    ...makeTfhd(opts.trackId, opts.defaultSampleSize),
    ...makeTfdt(opts.baseDecodeTime),
    ...makeTrun(opts.samples),
  ];

  if (opts.sencSamples) {
    trafChildren.push(...makeSenc(opts.sencSamples, opts.ivSize ?? 0));
  }

  const moof = box("moof", [
    ...makeMfhd(opts.sequenceNumber),
    ...box("traf", trafChildren),
  ]);

  // Add a minimal mdat
  const mdat = box("mdat", new Array(16).fill(0));

  return new Uint8Array([...moof, ...mdat]);
}

// --- Helpers ---

function makeTrack(overrides: Partial<ScanTrack> = {}): ScanTrack {
  return {
    label: "video 1920x1080",
    type: "video",
    ivSize: 0,
    timescale: 10_000_000,
    segments: [
      { index: 0, startTime: 0, endTime: 3.175, url: "http://test/seg0.m4s", startByte: 0, endByte: null },
    ],
    ...overrides,
  };
}

function okFetch(data: Uint8Array): () => Promise<SegmentFetchResult> {
  return async () => ({
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    contentLength: data.byteLength,
  });
}

// --- Tests ---

describe("segmentScanner", () => {
  describe("parseTrun", () => {
    it("extracts per-sample sizes", () => {
      const segment = new Uint8Array(
        box("moof", [
          ...box("traf", makeTrun([{ size: 1000 }, { size: 2000 }, { size: 500 }])),
        ]),
      );
      const samples = parseTrun(segment);
      expect(samples).toHaveLength(3);
      expect(samples![0].size).toBe(1000);
      expect(samples![1].size).toBe(2000);
      expect(samples![2].size).toBe(500);
    });

    it("returns null when no trun box", () => {
      const segment = new Uint8Array(box("moof", [...box("traf", makeTfhd(1))]));
      expect(parseTrun(segment)).toBeNull();
    });
  });

  describe("parseMfhd", () => {
    it("extracts sequence number", () => {
      const segment = new Uint8Array(box("moof", makeMfhd(42)));
      expect(parseMfhd(segment)).toBe(42);
    });
  });

  describe("parseTfdt", () => {
    it("extracts v0 base decode time", () => {
      const segment = new Uint8Array(
        box("moof", [...box("traf", makeTfdt(31750000))]),
      );
      expect(parseTfdt(segment)).toBe(31750000);
    });

    it("extracts v1 64-bit base decode time", () => {
      const segment = new Uint8Array(
        box("moof", [...box("traf", makeTfdt(4_042_406_834, 1))]),
      );
      expect(parseTfdt(segment)).toBe(4_042_406_834);
    });
  });

  describe("parseTfhdDefaultSize", () => {
    it("extracts default_sample_size", () => {
      const segment = new Uint8Array(
        box("moof", [...box("traf", makeTfhd(1, 4096))]),
      );
      expect(parseTfhdDefaultSize(segment)).toBe(4096);
    });

    it("returns null when no default size flag", () => {
      const segment = new Uint8Array(
        box("moof", [...box("traf", makeTfhd(1))]),
      );
      expect(parseTfhdDefaultSize(segment)).toBeNull();
    });
  });

  describe("BMFF-S01: senc/trun mismatch (CDP bug)", () => {
    it("detects sub-sample byte totals short of trun sizes", async () => {
      // Models the CDP bug: 10/27 samples have senc sub-sample totals 2-5 bytes
      // short of trun sample sizes
      const sampleCount = 27;
      const samples = Array.from({ length: sampleCount }, (_, i) => ({
        size: 10000 + i * 100,
      }));

      // senc sub-samples: first 17 match, last 10 are short by 2-5 bytes
      const sencSamples = samples.map((s, i) => {
        const shortfall = i >= 17 ? (i % 4) + 2 : 0; // 2-5 bytes short
        return {
          subsamples: [{ clear: 100, encrypted: s.size - 100 - shortfall }],
        };
      });

      const segment = makeMoof({
        sequenceNumber: 513,
        trackId: 5,
        baseDecodeTime: 0,
        samples,
        sencSamples,
        ivSize: 0,
      });

      const { issues } = await scanSegments(
        [makeTrack()],
        okFetch(segment),
      );

      const s01 = issues.filter((i) => i.id === "BMFF-S01");
      expect(s01).toHaveLength(1);
      expect(s01[0].severity).toBe("error");
      expect(s01[0].message).toContain("10/27");
      expect(s01[0].message).toContain("seg 0");
      expect(s01[0].detail).toContain("bytes short");
    });

    it("no issue when senc sub-samples match trun sizes", async () => {
      const samples = [{ size: 5000 }, { size: 3000 }, { size: 8000 }];
      const sencSamples = samples.map((s) => ({
        subsamples: [{ clear: 200, encrypted: s.size - 200 }],
      }));

      const segment = makeMoof({
        sequenceNumber: 1,
        trackId: 1,
        baseDecodeTime: 0,
        samples,
        sencSamples,
        ivSize: 0,
      });

      const { issues } = await scanSegments([makeTrack()], okFetch(segment));
      expect(issues.filter((i) => i.id === "BMFF-S01")).toHaveLength(0);
    });

    it("handles 8-byte IVs in senc (standard CENC)", async () => {
      const samples = [{ size: 5000 }, { size: 3000 }];
      // senc with 8-byte IVs, sub-samples match
      const sencSamples = samples.map((s) => ({
        subsamples: [{ clear: 200, encrypted: s.size - 200 }],
      }));

      const segment = makeMoof({
        sequenceNumber: 1,
        trackId: 1,
        baseDecodeTime: 0,
        samples,
        sencSamples,
        ivSize: 8,
      });

      const { issues } = await scanSegments(
        [makeTrack({ ivSize: 8 })],
        okFetch(segment),
      );
      expect(issues.filter((i) => i.id === "BMFF-S01")).toHaveLength(0);
    });

    it("skips comparison when no senc present", async () => {
      const segment = makeMoof({
        sequenceNumber: 1,
        trackId: 1,
        baseDecodeTime: 0,
        samples: [{ size: 5000 }],
        // no sencSamples
      });

      const { issues } = await scanSegments([makeTrack()], okFetch(segment));
      expect(issues.filter((i) => i.id === "BMFF-S01")).toHaveLength(0);
    });
  });

  describe("BMFF-S02: truncation detection", () => {
    it("detects Content-Length vs received bytes mismatch", async () => {
      const segment = makeMoof({
        sequenceNumber: 1,
        trackId: 1,
        baseDecodeTime: 0,
        samples: [{ size: 5000 }],
      });

      const { issues } = await scanSegments(
        [makeTrack()],
        async () => ({
          data: segment.buffer.slice(0, segment.byteLength),
          contentLength: segment.byteLength + 50000, // Claims more than delivered
        }),
      );

      const s02 = issues.filter((i) => i.id === "BMFF-S02");
      expect(s02).toHaveLength(1);
      expect(s02[0].severity).toBe("error");
      expect(s02[0].message).toContain("Truncated");
    });

    it("no issue when Content-Length matches", async () => {
      const segment = makeMoof({
        sequenceNumber: 1,
        trackId: 1,
        baseDecodeTime: 0,
        samples: [{ size: 5000 }],
      });

      const { issues } = await scanSegments([makeTrack()], okFetch(segment));
      expect(issues.filter((i) => i.id === "BMFF-S02")).toHaveLength(0);
    });

    it("reports fetch failure", async () => {
      const { issues } = await scanSegments(
        [makeTrack()],
        async () => { throw new Error("Network error"); },
      );
      const s02 = issues.filter((i) => i.id === "BMFF-S02");
      expect(s02).toHaveLength(1);
      expect(s02[0].message).toContain("Failed to fetch");
    });
  });

  describe("BMFF-S03: sequence numbers", () => {
    it("detects non-monotonic sequence numbers", async () => {
      const seg0 = makeMoof({
        sequenceNumber: 10,
        trackId: 1,
        baseDecodeTime: 0,
        samples: [{ size: 5000 }],
      });
      const seg1 = makeMoof({
        sequenceNumber: 8, // Goes backwards!
        trackId: 1,
        baseDecodeTime: 31750000,
        samples: [{ size: 5000 }],
      });

      const segments = [seg0, seg1];
      let callIdx = 0;

      const { issues } = await scanSegments(
        [makeTrack({
          segments: [
            { index: 0, startTime: 0, endTime: 3.175, url: "http://test/seg0.m4s", startByte: 0, endByte: null },
            { index: 1, startTime: 3.175, endTime: 6.35, url: "http://test/seg1.m4s", startByte: 0, endByte: null },
          ],
        })],
        async () => {
          const seg = segments[callIdx++];
          return { data: seg.buffer.slice(0), contentLength: seg.byteLength };
        },
        { maxSegmentsPerTrack: 2 },
      );

      const s03 = issues.filter((i) => i.id === "BMFF-S03");
      expect(s03).toHaveLength(1);
      expect(s03[0].message).toContain("seq 8");
      expect(s03[0].message).toContain("prev: 10");
    });
  });

  describe("BMFF-S04: tfdt timing", () => {
    it("detects tfdt mismatch with expected start time", async () => {
      const segment = makeMoof({
        sequenceNumber: 1,
        trackId: 1,
        baseDecodeTime: 50_000_000, // 5.0s at timescale 10M
        samples: [{ size: 5000 }],
      });

      const { issues } = await scanSegments(
        [makeTrack({
          timescale: 10_000_000,
          segments: [{
            index: 0,
            startTime: 0, // Expected 0s but tfdt says 5.0s
            endTime: 3.175,
            url: "http://test/seg0.m4s",
            startByte: 0,
            endByte: null,
          }],
        })],
        okFetch(segment),
      );

      const s04 = issues.filter((i) => i.id === "BMFF-S04");
      expect(s04).toHaveLength(1);
      expect(s04[0].detail).toContain("5.000s");
    });

    it("no issue when tfdt matches within tolerance", async () => {
      const timescale = 10_000_000;
      const startTime = 3.175;

      const segment = makeMoof({
        sequenceNumber: 2,
        trackId: 1,
        baseDecodeTime: Math.round(startTime * timescale), // Exact match
        samples: [{ size: 5000 }],
      });

      const { issues } = await scanSegments(
        [makeTrack({
          timescale,
          segments: [{
            index: 1, startTime, endTime: 6.35,
            url: "http://test/seg1.m4s", startByte: 0, endByte: null,
          }],
        })],
        okFetch(segment),
      );

      expect(issues.filter((i) => i.id === "BMFF-S04")).toHaveLength(0);
    });
  });

  describe("ISM origin-like full scenario", () => {
    it("detects senc/trun mismatch on HD track while SD track is clean", async () => {
      // Models: tracks 3-4 (SD) are clean, track 5 (720p) has senc mismatch in seg0
      const sdSamples = Array.from({ length: 27 }, (_, i) => ({
        size: 3000 + i * 50,
      }));
      const sdSencSamples = sdSamples.map((s) => ({
        subsamples: [{ clear: 100, encrypted: s.size - 100 }],
      }));

      const hdSamples = Array.from({ length: 27 }, (_, i) => ({
        size: 15000 + i * 200,
      }));
      // HD: last 10 samples have senc mismatch (2-5 bytes short)
      const hdSencSamples = hdSamples.map((s, i) => {
        const shortfall = i >= 17 ? (i % 4) + 2 : 0;
        return {
          subsamples: [{ clear: 200, encrypted: s.size - 200 - shortfall }],
        };
      });

      const sdSegment = makeMoof({
        sequenceNumber: 257,
        trackId: 3,
        baseDecodeTime: 0,
        samples: sdSamples,
        sencSamples: sdSencSamples,
        ivSize: 0,
      });

      const hdSegment = makeMoof({
        sequenceNumber: 513,
        trackId: 5,
        baseDecodeTime: 0,
        samples: hdSamples,
        sencSamples: hdSencSamples,
        ivSize: 0,
      });

      const { issues } = await scanSegments(
        [
          makeTrack({ label: "video 864x486", segments: [{ index: 0, startTime: 0, endTime: 3.175, url: "http://test/sd-seg0.m4s", startByte: 0, endByte: null }] }),
          makeTrack({ label: "video 1280x720", segments: [{ index: 0, startTime: 0, endTime: 3.183, url: "http://test/hd-seg0.m4s", startByte: 0, endByte: null }] }),
        ],
        async (url) => {
          const seg = url.includes("sd") ? sdSegment : hdSegment;
          return { data: seg.buffer.slice(0), contentLength: seg.byteLength };
        },
      );

      const s01 = issues.filter((i) => i.id === "BMFF-S01");
      expect(s01).toHaveLength(1);
      expect(s01[0].message).toContain("video 1280x720");
      expect(s01[0].message).toContain("10/27");
    });
  });

  it("calls onProgress for each track/segment", async () => {
    const segment = makeMoof({
      sequenceNumber: 1,
      trackId: 1,
      baseDecodeTime: 0,
      samples: [{ size: 5000 }],
    });

    const progress = vi.fn();
    await scanSegments(
      [
        makeTrack({ label: "video 720p" }),
        makeTrack({ label: "video 1080p" }),
      ],
      okFetch(segment),
      undefined,
      progress,
    );

    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ trackLabel: "video 720p", trackNumber: 1, totalTracks: 2 }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ trackLabel: "video 1080p", trackNumber: 2, totalTracks: 2 }),
    );
  });

  it("respects maxSegmentsPerTrack option", async () => {
    const fetchFn = vi.fn().mockImplementation(async () => {
      const seg = makeMoof({ sequenceNumber: 1, trackId: 1, baseDecodeTime: 0, samples: [{ size: 100 }] });
      return { data: seg.buffer.slice(0), contentLength: seg.byteLength };
    });

    await scanSegments(
      [makeTrack({
        segments: [
          { index: 0, startTime: 0, endTime: 3, url: "http://test/s0.m4s", startByte: 0, endByte: null },
          { index: 1, startTime: 3, endTime: 6, url: "http://test/s1.m4s", startByte: 0, endByte: null },
          { index: 2, startTime: 6, endTime: 9, url: "http://test/s2.m4s", startByte: 0, endByte: null },
        ],
      })],
      fetchFn,
      { maxSegmentsPerTrack: 2 },
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

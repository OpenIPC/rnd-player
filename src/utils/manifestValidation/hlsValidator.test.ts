import { describe, it, expect } from "vitest";
import {
  parseHlsPlaylist,
  parseAttributeList,
  validateHls,
  validateHlsMediaPlaylist,
  fetchAndValidateHlsChildren,
} from "./hlsValidator";

// --- Helpers ---

function multivariant(variants: string[], extra = ""): string {
  return `#EXTM3U\n${extra}${variants.join("\n")}\n`;
}

function streamInf(attrs: string, uri: string): string {
  return `#EXT-X-STREAM-INF:${attrs}\n${uri}`;
}

function mediaTag(attrs: string): string {
  return `#EXT-X-MEDIA:${attrs}`;
}

function mediaPlaylist(segments: string[], opts: { targetDuration?: number; endList?: boolean; version?: number; extra?: string } = {}): string {
  const td = opts.targetDuration ?? 6;
  const lines = ["#EXTM3U"];
  if (opts.version !== undefined) lines.push(`#EXT-X-VERSION:${opts.version}`);
  lines.push(`#EXT-X-TARGETDURATION:${td}`);
  if (opts.extra) lines.push(opts.extra);
  lines.push(...segments);
  if (opts.endList !== false) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

function segment(duration: number, uri: string): string {
  return `#EXTINF:${duration.toFixed(5)},\n${uri}`;
}

// --- Parser tests ---

describe("parseAttributeList", () => {
  it("parses simple attributes", () => {
    const attrs = parseAttributeList('BANDWIDTH=1280000,CODECS="avc1.4d401f"');
    expect(attrs.get("BANDWIDTH")).toBe("1280000");
    expect(attrs.get("CODECS")).toBe("avc1.4d401f");
  });

  it("handles commas inside quoted strings", () => {
    const attrs = parseAttributeList('CODECS="avc1.4d401f,mp4a.40.2",BANDWIDTH=1280000');
    expect(attrs.get("CODECS")).toBe("avc1.4d401f,mp4a.40.2");
    expect(attrs.get("BANDWIDTH")).toBe("1280000");
  });

  it("parses RESOLUTION", () => {
    const attrs = parseAttributeList("RESOLUTION=1920x1080,BANDWIDTH=5000000");
    expect(attrs.get("RESOLUTION")).toBe("1920x1080");
  });

  it("handles quoted GROUP-ID", () => {
    const attrs = parseAttributeList('TYPE=AUDIO,GROUP-ID="audio-main",NAME="English"');
    expect(attrs.get("GROUP-ID")).toBe("audio-main");
    expect(attrs.get("NAME")).toBe("English");
  });
});

describe("parseHlsPlaylist", () => {
  it("detects multivariant playlist", () => {
    const text = multivariant([
      streamInf("BANDWIDTH=1280000,RESOLUTION=1280x720", "720p.m3u8"),
      streamInf("BANDWIDTH=2560000,RESOLUTION=1920x1080", "1080p.m3u8"),
    ]);
    const parsed = parseHlsPlaylist(text);
    expect(parsed.isMultivariant).toBe(true);
    expect(parsed.streamInfs).toHaveLength(2);
    expect(parsed.streamInfs[0].bandwidth).toBe(1280000);
    expect(parsed.streamInfs[0].resolution).toEqual({ width: 1280, height: 720 });
    expect(parsed.streamInfs[1].uri).toBe("1080p.m3u8");
  });

  it("detects media playlist", () => {
    const text = mediaPlaylist([segment(6, "seg0.ts"), segment(6, "seg1.ts")]);
    const parsed = parseHlsPlaylist(text);
    expect(parsed.isMultivariant).toBe(false);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.targetDuration).toBe(6);
    expect(parsed.endList).toBe(true);
  });

  it("detects BOM", () => {
    const text = "\uFEFF#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    expect(parsed.hasBom).toBe(true);
    expect(parsed.hasExtm3u).toBe(true);
  });

  it("parses CODECS with commas in quoted string", () => {
    const text = multivariant([
      streamInf('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720', "720p.m3u8"),
    ]);
    const parsed = parseHlsPlaylist(text);
    expect(parsed.streamInfs[0].codecs).toBe("avc1.4d401f,mp4a.40.2");
  });

  it("parses EXT-X-MEDIA tags", () => {
    const text = multivariant(
      [streamInf('BANDWIDTH=1280000,AUDIO="aud",RESOLUTION=1280x720', "720p.m3u8")],
      mediaTag('TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="eng.m3u8"') + "\n",
    );
    const parsed = parseHlsPlaylist(text);
    expect(parsed.mediaTags).toHaveLength(1);
    expect(parsed.mediaTags[0].type).toBe("AUDIO");
    expect(parsed.mediaTags[0].groupId).toBe("aud");
  });

  it("parses FRAME-RATE", () => {
    const text = multivariant([
      streamInf("BANDWIDTH=1280000,RESOLUTION=1280x720,FRAME-RATE=29.970", "720p.m3u8"),
    ]);
    const parsed = parseHlsPlaylist(text);
    expect(parsed.streamInfs[0].frameRate).toBeCloseTo(29.97, 2);
  });

  it("parses EXT-X-VERSION", () => {
    const text = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    expect(parsed.version).toBe(7);
    expect(parsed.versionLines).toEqual([2]);
  });

  it("parses I-frame stream infs", () => {
    const text = multivariant([
      streamInf("BANDWIDTH=1280000,RESOLUTION=1280x720", "720p.m3u8"),
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=128000,CODECS="avc1.4d401f",URI="iframe.m3u8"',
    ]);
    const parsed = parseHlsPlaylist(text);
    expect(parsed.iFrameStreamInfs).toHaveLength(1);
    expect(parsed.iFrameStreamInfs[0].uri).toBe("iframe.m3u8");
  });

  it("detects duplicate attributes", () => {
    const text = multivariant([
      streamInf("BANDWIDTH=1280000,BANDWIDTH=2560000,RESOLUTION=1280x720", "720p.m3u8"),
    ]);
    const parsed = parseHlsPlaylist(text);
    expect(parsed.duplicateAttrs).toHaveLength(1);
    expect(parsed.duplicateAttrs[0].attr).toBe("BANDWIDTH");
  });
});

// --- Phase 1: Structural checks ---

describe("validateHls — structural checks", () => {
  it("HLS-001: missing #EXTM3U", () => {
    const parsed = parseHlsPlaylist("#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n");
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-001")).toBeDefined();
  });

  it("no HLS-001 for valid playlist", () => {
    const parsed = parseHlsPlaylist(mediaPlaylist([segment(6, "seg.ts")]));
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-001")).toBeUndefined();
  });

  it("HLS-002: missing EXT-X-VERSION", () => {
    const parsed = parseHlsPlaylist(mediaPlaylist([segment(6, "seg.ts")]));
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-002")).toBeDefined();
  });

  it("HLS-002: multiple EXT-X-VERSION tags", () => {
    const text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    const hls002 = issues.find((i) => i.id === "HLS-002");
    expect(hls002).toBeDefined();
    expect(hls002!.message).toContain("Multiple");
  });

  it("HLS-004: both variants and segments", () => {
    const text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\n720p.m3u8\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n";
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-004")).toBeDefined();
  });

  it("HLS-005: BOM detected", () => {
    const text = "\uFEFF#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-005" && i.message.includes("BOM"))).toBeDefined();
  });

  it("HLS-008: duplicate attributes", () => {
    const text = multivariant([
      streamInf("BANDWIDTH=1280000,BANDWIDTH=2560000,RESOLUTION=1280x720", "720p.m3u8"),
    ]);
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    const hls008 = issues.find((i) => i.id === "HLS-008");
    expect(hls008).toBeDefined();
    expect(hls008!.severity).toBe("error");
    expect(hls008!.message).toContain("BANDWIDTH");
  });
});

// --- Phase 1: Multivariant-specific checks ---

describe("validateHls — multivariant checks", () => {
  it("HLS-101: missing BANDWIDTH", () => {
    const text = multivariant([streamInf("RESOLUTION=1280x720", "720p.m3u8")]);
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-101")).toBeDefined();
  });

  it("HLS-102: missing CODECS", () => {
    const text = multivariant([streamInf("BANDWIDTH=1280000,RESOLUTION=1280x720", "720p.m3u8")]);
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-102")).toBeDefined();
  });

  it("no HLS-102 when CODECS present", () => {
    const text = multivariant([
      streamInf('BANDWIDTH=1280000,CODECS="avc1.4d401f",RESOLUTION=1280x720', "720p.m3u8"),
    ]);
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-102")).toBeUndefined();
  });

  it("HLS-103: video variant missing RESOLUTION", () => {
    const text = multivariant([
      streamInf('BANDWIDTH=1280000,CODECS="avc1.4d401f"', "720p.m3u8"),
    ]);
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-103")).toBeDefined();
  });

  it("no HLS-103 for audio-only variant", () => {
    const text = multivariant([
      streamInf('BANDWIDTH=128000,CODECS="mp4a.40.2"', "audio.m3u8"),
    ]);
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-103")).toBeUndefined();
  });

  it("HLS-104: video variant missing FRAME-RATE", () => {
    const text = multivariant([
      streamInf('BANDWIDTH=1280000,CODECS="avc1.4d401f",RESOLUTION=1280x720', "720p.m3u8"),
    ]);
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-104")).toBeDefined();
  });

  it("no HLS-104 when FRAME-RATE present", () => {
    const text = multivariant([
      streamInf('BANDWIDTH=1280000,CODECS="avc1.4d401f",RESOLUTION=1280x720,FRAME-RATE=29.970', "720p.m3u8"),
    ]);
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-104")).toBeUndefined();
  });

  it("HLS-105: EXT-X-MEDIA missing TYPE/GROUP-ID/NAME", () => {
    const text = multivariant(
      [streamInf("BANDWIDTH=1280000,RESOLUTION=1280x720", "720p.m3u8")],
      '#EXT-X-MEDIA:URI="eng.m3u8"\n',
    );
    const issues = validateHls(parseHlsPlaylist(text));
    const hls105 = issues.find((i) => i.id === "HLS-105");
    expect(hls105).toBeDefined();
    expect(hls105!.message).toContain("TYPE");
    expect(hls105!.message).toContain("GROUP-ID");
    expect(hls105!.message).toContain("NAME");
  });

  it("no HLS-105 when all required attrs present", () => {
    const text = multivariant(
      [streamInf('BANDWIDTH=1280000,AUDIO="aud",RESOLUTION=1280x720', "720p.m3u8")],
      mediaTag('TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="eng.m3u8"') + "\n",
    );
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-105")).toBeUndefined();
  });

  it("HLS-106: CLOSED-CAPTIONS with URI", () => {
    const text = multivariant(
      [streamInf('BANDWIDTH=1280000,CLOSED-CAPTIONS="cc",RESOLUTION=1280x720', "720p.m3u8")],
      mediaTag('TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC",URI="cc.m3u8"') + "\n",
    );
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-106")).toBeDefined();
  });

  it("HLS-107: dangling rendition group reference", () => {
    const text = multivariant([
      streamInf('BANDWIDTH=1280000,AUDIO="nonexistent",RESOLUTION=1280x720', "720p.m3u8"),
    ]);
    const issues = validateHls(parseHlsPlaylist(text));
    const hls107 = issues.find((i) => i.id === "HLS-107");
    expect(hls107).toBeDefined();
    expect(hls107!.message).toContain("nonexistent");
  });

  it("no HLS-107 when group is defined", () => {
    const text = multivariant(
      [streamInf('BANDWIDTH=1280000,AUDIO="aud",RESOLUTION=1280x720', "720p.m3u8")],
      mediaTag('TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="eng.m3u8"') + "\n",
    );
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-107")).toBeUndefined();
  });

  it("HLS-108: VOD without I-frame playlists", () => {
    // A multivariant playlist that is VOD-like (has ENDLIST in the text but that doesn't make it VOD
    // for multivariant — test with explicit endList scenario)
    const text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720\n720p.m3u8\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    // The endList is set for the playlist
    const issues = validateHls(parsed);
    // This should fire since it's "VOD" (has ENDLIST) but no I-frame stream inf
    expect(issues.find((i) => i.id === "HLS-108")).toBeDefined();
  });

  it("no HLS-108 when I-frame stream inf present", () => {
    const text = multivariant([
      streamInf("BANDWIDTH=1280000,RESOLUTION=1280x720", "720p.m3u8"),
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=128000,CODECS="avc1.4d401f",URI="iframe.m3u8"',
    ]);
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-108")).toBeUndefined();
  });

  it("HLS-109: no cellular-compatible variant", () => {
    const text = multivariant([
      streamInf("BANDWIDTH=1280000,RESOLUTION=1280x720", "720p.m3u8"),
      streamInf("BANDWIDTH=2560000,RESOLUTION=1920x1080", "1080p.m3u8"),
    ]);
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-109")).toBeDefined();
  });

  it("no HLS-109 when low-bandwidth variant exists", () => {
    const text = multivariant([
      streamInf("BANDWIDTH=150000,RESOLUTION=416x234", "low.m3u8"),
      streamInf("BANDWIDTH=1280000,RESOLUTION=1280x720", "720p.m3u8"),
    ]);
    const issues = validateHls(parseHlsPlaylist(text));
    expect(issues.find((i) => i.id === "HLS-109")).toBeUndefined();
  });
});

// --- Phase 2: Media playlist checks ---

describe("validateHls — media playlist checks", () => {
  it("HLS-003: missing TARGETDURATION", () => {
    const text = "#EXTM3U\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-003")).toBeDefined();
  });

  it("HLS-006: MEDIA-SEQUENCE after first segment", () => {
    const text = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6,\nseg1.ts\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-006")).toBeDefined();
  });

  it("no HLS-006 when MEDIA-SEQUENCE before segments", () => {
    const text = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-006")).toBeUndefined();
  });

  it("HLS-007: DISCONTINUITY-SEQUENCE after first segment", () => {
    const text = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-DISCONTINUITY-SEQUENCE:0\n#EXTINF:6,\nseg1.ts\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-007")).toBeDefined();
  });

  it("HLS-201: segment duration exceeds TARGETDURATION", () => {
    const text = mediaPlaylist([segment(7.5, "seg.ts")]);
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    const hls201 = issues.find((i) => i.id === "HLS-201");
    expect(hls201).toBeDefined();
    expect(hls201!.severity).toBe("error");
  });

  it("no HLS-201 when ceil(duration) == TARGETDURATION", () => {
    const text = mediaPlaylist([segment(5.5, "seg.ts")]);
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-201")).toBeUndefined();
  });

  it("HLS-205: byte-range offset missing without predecessor", () => {
    const text = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n#EXT-X-BYTERANGE:1000\nvideo.mp4\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-205")).toBeDefined();
  });

  it("HLS-207: live playlist with too few segments", () => {
    const text = mediaPlaylist([segment(4, "seg.ts")], { targetDuration: 6, endList: false });
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-207")).toBeDefined();
  });

  it("no HLS-207 for VOD playlist", () => {
    const text = mediaPlaylist([segment(4, "seg.ts")], { targetDuration: 6 });
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-207")).toBeUndefined();
  });

  it("HLS-208: fMP4 segment without EXT-X-MAP", () => {
    const text = mediaPlaylist([segment(6, "seg0.m4s"), segment(6, "seg1.m4s")]);
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-208")).toBeDefined();
  });

  it("no HLS-208 when EXT-X-MAP is present", () => {
    const text = mediaPlaylist([segment(6, "seg0.m4s")], { extra: '#EXT-X-MAP:URI="init.mp4"' });
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-208")).toBeUndefined();
  });

  it("no HLS-208 for .ts segments", () => {
    const text = mediaPlaylist([segment(6, "seg0.ts")]);
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);
    expect(issues.find((i) => i.id === "HLS-208")).toBeUndefined();
  });
});

// --- Phase 2: Cross-rendition checks via validateHlsMediaPlaylist ---

describe("validateHlsMediaPlaylist", () => {
  it("validates child playlist with label prefix", () => {
    const text = "#EXTM3U\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n";
    const parsed = parseHlsPlaylist(text);
    const issues = validateHlsMediaPlaylist({ playlist: parsed, sourceUrl: "http://test/720p.m3u8", label: "720p" });
    const hls003 = issues.find((i) => i.id === "HLS-003");
    expect(hls003).toBeDefined();
    expect(hls003!.message).toContain("[720p]");
  });
});

// --- HLS-206: Discontinuity count mismatch ---

describe("fetchAndValidateHlsChildren — HLS-206", () => {
  const masterText = multivariant([
    streamInf("BANDWIDTH=1280000,RESOLUTION=1280x720", "720p.m3u8"),
    streamInf("BANDWIDTH=2560000,RESOLUTION=1920x1080", "1080p.m3u8"),
  ]);

  it("HLS-206: discontinuity count mismatch", async () => {
    const master = parseHlsPlaylist(masterText);
    const children: Record<string, string> = {
      "http://cdn/720p.m3u8": mediaPlaylist([
        segment(6, "seg0.ts"),
        "#EXT-X-DISCONTINUITY",
        segment(6, "seg1.ts"),
      ]),
      "http://cdn/1080p.m3u8": mediaPlaylist([
        segment(6, "seg0.ts"),
        segment(6, "seg1.ts"),
      ]),
    };
    const fetchFn = async (url: string) => {
      if (url in children) return children[url];
      throw new Error("not found");
    };

    const issues = await fetchAndValidateHlsChildren(master, "http://cdn/master.m3u8", fetchFn);
    expect(issues.find((i) => i.id === "HLS-206")).toBeDefined();
  });

  it("no HLS-206 when counts match", async () => {
    const master = parseHlsPlaylist(masterText);
    const childText = mediaPlaylist([segment(6, "seg0.ts"), segment(6, "seg1.ts")]);
    const fetchFn = async () => childText;

    const issues = await fetchAndValidateHlsChildren(master, "http://cdn/master.m3u8", fetchFn);
    expect(issues.find((i) => i.id === "HLS-206")).toBeUndefined();
  });

  it("handles fetch failures gracefully", async () => {
    const master = parseHlsPlaylist(masterText);
    const fetchFn = async () => { throw new Error("network error"); };

    const issues = await fetchAndValidateHlsChildren(master, "http://cdn/master.m3u8", fetchFn);
    // Should not throw, returns empty or no cross-rendition issues
    expect(issues.find((i) => i.id === "HLS-206")).toBeUndefined();
  });
});

// --- HLS-209: Audio/video duration mismatch ---

describe("fetchAndValidateHlsChildren — HLS-209", () => {
  it("HLS-209: audio 60% shorter than video (QA ISM bug)", async () => {
    // Mirrors the real ISM bug: 95 segments for both, but video=3.2s, audio=2.0s
    const masterText = multivariant(
      [
        streamInf('BANDWIDTH=1280000,CODECS="avc1.4D401F,mp4a.40.2",AUDIO="aud",RESOLUTION=1280x720', "video/stream.m3u8"),
      ],
      mediaTag('TYPE=AUDIO,GROUP-ID="aud",NAME="Main",URI="audio/stream.m3u8"') + "\n",
    );
    const master = parseHlsPlaylist(masterText);

    // 95 video segments × 3.2s = 304s (5m04s)
    const videoSegs = Array.from({ length: 95 }, (_, i) => segment(3.2, `s-${i + 1}.m4s`));
    const videoChild = mediaPlaylist(videoSegs, { targetDuration: 4, extra: '#EXT-X-MAP:URI="s-0.m4s"' });

    // 95 audio segments × 2.0s = 190s (3m10s)
    const audioSegs = Array.from({ length: 95 }, (_, i) => segment(2.0, `s-${i + 1}.m4s`));
    const audioChild = mediaPlaylist(audioSegs, { targetDuration: 2, extra: '#EXT-X-MAP:URI="s-0.m4s"' });

    const children: Record<string, string> = {
      "http://cdn/video/stream.m3u8": videoChild,
      "http://cdn/audio/stream.m3u8": audioChild,
    };
    const fetchFn = async (url: string) => {
      if (url in children) return children[url];
      throw new Error("not found");
    };

    const issues = await fetchAndValidateHlsChildren(master, "http://cdn/master.m3u8", fetchFn);
    const hls209 = issues.find((i) => i.id === "HLS-209");
    expect(hls209).toBeDefined();
    expect(hls209!.severity).toBe("error");
    expect(hls209!.category).toBe("Timeline");
    expect(hls209!.message).toContain("114");
    expect(hls209!.message).toContain("37%");
    expect(hls209!.detail).toContain("3m10s");
    expect(hls209!.detail).toContain("5m4s");
  });

  it("no HLS-209 when audio/video durations match", async () => {
    const masterText = multivariant(
      [
        streamInf('BANDWIDTH=1280000,CODECS="avc1.4D401F,mp4a.40.2",AUDIO="aud",RESOLUTION=1280x720', "video/stream.m3u8"),
      ],
      mediaTag('TYPE=AUDIO,GROUP-ID="aud",NAME="Main",URI="audio/stream.m3u8"') + "\n",
    );
    const master = parseHlsPlaylist(masterText);

    const segs = [segment(6, "seg0.ts"), segment(6, "seg1.ts"), segment(6, "seg2.ts")];
    const childText = mediaPlaylist(segs, { targetDuration: 6 });
    const fetchFn = async () => childText;

    const issues = await fetchAndValidateHlsChildren(master, "http://cdn/master.m3u8", fetchFn);
    expect(issues.find((i) => i.id === "HLS-209")).toBeUndefined();
  });

  it("HLS-209: small difference (<2s) is not flagged", async () => {
    const masterText = multivariant(
      [
        streamInf('BANDWIDTH=1280000,CODECS="avc1.4D401F,mp4a.40.2",AUDIO="aud",RESOLUTION=1280x720', "video/stream.m3u8"),
      ],
      mediaTag('TYPE=AUDIO,GROUP-ID="aud",NAME="Main",URI="audio/stream.m3u8"') + "\n",
    );
    const master = parseHlsPlaylist(masterText);

    const videoChild = mediaPlaylist([segment(6, "seg0.ts"), segment(6, "seg1.ts")], { targetDuration: 6 });
    // Audio 1s shorter — within tolerance
    const audioChild = mediaPlaylist([segment(5.5, "seg0.ts"), segment(5.5, "seg1.ts")], { targetDuration: 6 });

    const children: Record<string, string> = {
      "http://cdn/video/stream.m3u8": videoChild,
      "http://cdn/audio/stream.m3u8": audioChild,
    };
    const fetchFn = async (url: string) => {
      if (url in children) return children[url];
      throw new Error("not found");
    };

    const issues = await fetchAndValidateHlsChildren(master, "http://cdn/master.m3u8", fetchFn);
    expect(issues.find((i) => i.id === "HLS-209")).toBeUndefined();
  });
});

// --- QA bug scenario ---

describe("QA regression — duration mismatch HLS stream", () => {
  it("detects issues in realistic multivariant with duration-mismatched variants", () => {
    const text = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,FRAME-RATE=25.000
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=960x540,FRAME-RATE=25.000
540p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=25.000
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=25.000
1080p.m3u8
`;
    const parsed = parseHlsPlaylist(text);
    const issues = validateHls(parsed);

    // Should be a valid multivariant — no HLS-001, HLS-004
    expect(issues.find((i) => i.id === "HLS-001")).toBeUndefined();
    expect(issues.find((i) => i.id === "HLS-004")).toBeUndefined();

    // Missing CODECS warning
    expect(issues.filter((i) => i.id === "HLS-102")).toHaveLength(4);

    // No cellular variant
    expect(issues.find((i) => i.id === "HLS-109")).toBeDefined();
  });

  it("child playlist with segment exceeding targetDuration", async () => {
    const masterText = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
720p.m3u8
`;
    const master = parseHlsPlaylist(masterText);

    const child360 = mediaPlaylist(
      [segment(6, "seg0.ts"), segment(6, "seg1.ts"), segment(6, "seg2.ts")],
      { targetDuration: 6 },
    );
    const child720 = mediaPlaylist(
      [segment(6, "seg0.ts"), segment(10.5, "seg1.ts")],
      { targetDuration: 6 },
    );

    const children: Record<string, string> = {
      "http://cdn/360p.m3u8": child360,
      "http://cdn/720p.m3u8": child720,
    };
    const fetchFn = async (url: string) => {
      if (url in children) return children[url];
      throw new Error("not found");
    };

    const issues = await fetchAndValidateHlsChildren(master, "http://cdn/master.m3u8", fetchFn);

    // 720p child has segment exceeding TARGETDURATION
    const hls201 = issues.filter((i) => i.id === "HLS-201");
    expect(hls201.length).toBeGreaterThanOrEqual(1);
    expect(hls201[0].message).toContain("[1280x720]");
  });

  it("ISM origin bug: 95 segs × 3.2s video vs 95 segs × 2.0s audio", async () => {
    // Exact reproduction of QA-reported ISM manifest bug
    const masterText = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud_mp4a.40.2",NAME="Commentary",LANGUAGE="ru",DEFAULT=YES,URI="audio_15/stream.m3u8"
#EXT-X-STREAM-INF:AUDIO="aud_mp4a.40.2",BANDWIDTH=651362,CODECS="avc1.4D4015,mp4a.40.2",RESOLUTION=480x270,FRAME-RATE=25
video_1/stream.m3u8
#EXT-X-STREAM-INF:AUDIO="aud_mp4a.40.2",BANDWIDTH=5309954,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=25
video_7/stream.m3u8
`;
    const master = parseHlsPlaylist(masterText);

    // Video: 95 × 3.2s = 304s
    const videoSegs = Array.from({ length: 95 }, (_, i) => segment(3.2, `s-${i + 1}.m4s`));
    const videoPlaylist = mediaPlaylist(videoSegs, { targetDuration: 4, version: 6, extra: '#EXT-X-MAP:URI="s-0.m4s"' });

    // Audio: 95 × 2.0s = 190s (pattern: 3× 2.005330 + 1× 1.983997)
    const audioSegs: string[] = [];
    for (let i = 0; i < 95; i++) {
      const dur = (i % 4 === 3) ? 1.983997 : 2.005330;
      audioSegs.push(segment(dur, `s-${i + 1}.m4s`));
    }
    const audioPlaylist = mediaPlaylist(audioSegs, { targetDuration: 2, version: 6, extra: '#EXT-X-MAP:URI="s-0.m4s"' });

    const children: Record<string, string> = {
      "http://cdn/video_1/stream.m3u8": videoPlaylist,
      "http://cdn/video_7/stream.m3u8": videoPlaylist,
      "http://cdn/audio_15/stream.m3u8": audioPlaylist,
    };
    const fetchFn = async (url: string) => {
      if (url in children) return children[url];
      throw new Error("not found");
    };

    const issues = await fetchAndValidateHlsChildren(master, "http://cdn/master.m3u8", fetchFn);

    // HLS-209: Audio/video duration mismatch
    const hls209 = issues.filter((i) => i.id === "HLS-209");
    expect(hls209).toHaveLength(1);
    expect(hls209[0].severity).toBe("error");
    expect(hls209[0].message).toContain("114");
    expect(hls209[0].detail).toContain("audio");
    expect(hls209[0].detail).toContain("480x270");
  });
});

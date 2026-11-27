import { describe, it, expect } from "vitest";
import { checkCodecSyntax, describeCodecProbe, extractDeclaredCodecs, probeCodecs } from "./codecProbe";

const MALFORMED_AV1_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet id="1" mimeType="video/mp4" contentType="video">
      <SegmentTemplate initialization="init.mp4" media="$Number$.m4s" timescale="1000" duration="2000"/>
      <Representation id="1" bandwidth="4774166" codecs="av01.0.08M.0" width="1920" height="1080"/>
    </AdaptationSet>
    <AdaptationSet id="2" mimeType="audio/mp4" codecs="mp4a.40.2">
      <Representation id="a1" bandwidth="128000"/>
    </AdaptationSet>
    <AdaptationSet id="3" mimeType="text/vtt">
      <Representation id="t1" bandwidth="100"/>
    </AdaptationSet>
  </Period>
</MPD>`;

/** Mimics Chrome: only well-formed AV1 / AAC strings are supported. */
const chromeLike = (type: string) =>
  /codecs="(av01\.0\.\d{2}M\.(08|10)|mp4a\.40\.2|avc1\.64001f)"/.test(type);

describe("codecProbe", () => {
  describe("extractDeclaredCodecs", () => {
    it("reads DASH codecs with AdaptationSet inheritance and skips text", () => {
      expect(extractDeclaredCodecs(MALFORMED_AV1_MPD)).toEqual([
        { mimeType: "video/mp4", codecs: "av01.0.08M.0", source: "Representation 1" },
        { mimeType: "audio/mp4", codecs: "mp4a.40.2", source: "Representation a1" },
      ]);
    });

    it("reads HLS CODECS and classifies audio vs video", () => {
      const m3u8 = [
        "#EXTM3U",
        '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2,wvtt"',
        "v1.m3u8",
      ].join("\n");
      expect(extractDeclaredCodecs(m3u8)).toEqual([
        { mimeType: "video/mp4", codecs: "avc1.64001f", source: "EXT-X-STREAM-INF #1" },
        { mimeType: "audio/mp4", codecs: "mp4a.40.2", source: "EXT-X-STREAM-INF #1" },
      ]);
    });

    it("returns nothing for unknown formats", () => {
      expect(extractDeclaredCodecs("not a manifest")).toEqual([]);
    });
  });

  describe("checkCodecSyntax", () => {
    it("accepts well-formed AV1 and H.264", () => {
      expect(checkCodecSyntax("av01.0.08M.08")).toBeNull();
      expect(checkCodecSyntax("av01.0.13M.10.0.110.09.16.09.0")).toBeNull();
      expect(checkCodecSyntax("avc1.64001F")).toBeNull();
      expect(checkCodecSyntax("hvc1.1.6.L93.B0")).toBeNull();
    });

    it("flags AV1 bit depth '0' and suggests 08", () => {
      expect(checkCodecSyntax("av01.0.08M.0")).toEqual({
        reason: expect.stringContaining("bit depth"),
        suggestion: "av01.0.08M.08",
      });
    });

    it("flags single-digit AV1 fields and zero-pads them", () => {
      expect(checkCodecSyntax("av01.0.8M.8")?.suggestion).toBe("av01.0.08M.08");
    });

    it("flags bad H.264 and empty codecs", () => {
      expect(checkCodecSyntax("avc1.640")).not.toBeNull();
      expect(checkCodecSyntax("")).not.toBeNull();
    });
  });

  describe("probeCodecs + describeCodecProbe", () => {
    it("pinpoints the malformed AV1 string", () => {
      const results = probeCodecs(extractDeclaredCodecs(MALFORMED_AV1_MPD), chromeLike);
      expect(results.map((r) => r.supported)).toEqual([false, true]);
      expect(results[0]).toMatchObject({ suggestion: "av01.0.08M.08", suggestionSupported: true });

      const { summary, details } = describeCodecProbe(results);
      expect(summary).toBe('No playable streams: malformed codec string "av01.0.08M.0" in manifest');
      expect(details.some((d) => d.includes('✗ rejected: video/mp4; codecs="av01.0.08M.0"'))).toBe(true);
      expect(details.some((d) => d.includes('expected "av01.0.08M.08" (supported by this browser)'))).toBe(true);
      expect(details.some((d) => d.includes('✓ supported: audio/mp4; codecs="mp4a.40.2"'))).toBe(true);
    });

    it("lists well-formed but unsupported codecs", () => {
      const results = probeCodecs(
        [{ mimeType: "video/mp4", codecs: "hvc1.1.6.L93.B0", source: "Representation v" }],
        chromeLike,
      );
      expect(describeCodecProbe(results).summary).toBe(
        "No playable streams: hvc1.1.6.L93.B0 not supported by this browser",
      );
    });

    it("dedupes identical mime/codecs pairs", () => {
      const d = { mimeType: "video/mp4", codecs: "avc1.64001f", source: "x" };
      expect(probeCodecs([d, { ...d, source: "y" }], chromeLike)).toHaveLength(1);
    });

    it("treats a throwing isTypeSupported as unsupported", () => {
      const results = probeCodecs(
        [{ mimeType: "video/mp4", codecs: "avc1.64001f", source: "x" }],
        () => { throw new Error("boom"); },
      );
      expect(results[0].supported).toBe(false);
    });
  });
});

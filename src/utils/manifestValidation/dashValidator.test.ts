import { describe, it, expect } from "vitest";
import { parseMpd, validateDash, normalizeFrameRate } from "./dashValidator";

// Helper to build a minimal MPD XML string
function mpd(body: string, attrs = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" minBufferTime="PT2S"${attrs ? " " + attrs : ""}>
  <Period>
    ${body}
  </Period>
</MPD>`;
}

function videoAS(reps: string, asAttrs = ""): string {
  return `<AdaptationSet contentType="video" mimeType="video/mp4"${asAttrs ? " " + asAttrs : ""}>${reps}</AdaptationSet>`;
}

function rep(attrs: string): string {
  return `<Representation ${attrs}/>`;
}

describe("normalizeFrameRate", () => {
  it("parses integer string", () => {
    expect(normalizeFrameRate("25")).toBe(25);
  });

  it("parses fraction N/1", () => {
    expect(normalizeFrameRate("25/1")).toBe(25);
  });

  it("parses NTSC fraction", () => {
    expect(normalizeFrameRate("30000/1001")).toBeCloseTo(29.97, 1);
  });

  it("returns NaN for garbage", () => {
    expect(normalizeFrameRate("abc")).toBeNaN();
  });

  it("returns NaN for empty string", () => {
    expect(normalizeFrameRate("")).toBeNaN();
  });

  it("handles division by zero", () => {
    expect(normalizeFrameRate("30/0")).toBeNaN();
  });
});

describe("parseMpd", () => {
  it("extracts MPD attributes", () => {
    const xml = mpd("");
    const parsed = parseMpd(xml);
    expect(parsed.namespace).toContain("urn:mpeg:dash:schema:mpd:2011");
    expect(parsed.profiles).toBe("urn:mpeg:dash:profile:isoff-live:2011");
    expect(parsed.type).toBe("static");
    expect(parsed.minBufferTime).toBe("PT2S");
  });

  it("extracts representations with attribute inheritance", () => {
    const xml = mpd(
      videoAS(
        rep('id="1" bandwidth="1000000" width="1280" height="720" frameRate="25"') +
        rep('id="2" bandwidth="2000000" width="1920" height="1080" frameRate="25"'),
      ),
    );
    const parsed = parseMpd(xml);
    expect(parsed.periods).toHaveLength(1);
    expect(parsed.periods[0].adaptationSets).toHaveLength(1);
    const as = parsed.periods[0].adaptationSets[0];
    expect(as.mimeType).toBe("video/mp4");
    expect(as.representations).toHaveLength(2);
    expect(as.representations[0].width).toBe(1280);
    expect(as.representations[1].width).toBe(1920);
  });

  it("returns empty structure for malformed XML", () => {
    const parsed = parseMpd("<not valid xml<<<");
    expect(parsed.periods).toHaveLength(0);
  });

  it("handles AdaptationSet-level frameRate inheritance", () => {
    const xml = mpd(
      `<AdaptationSet contentType="video" mimeType="video/mp4" frameRate="25">
        <Representation id="1" bandwidth="1000000" width="1280" height="720"/>
        <Representation id="2" bandwidth="2000000" width="1920" height="1080"/>
      </AdaptationSet>`,
    );
    const parsed = parseMpd(xml);
    const as = parsed.periods[0].adaptationSets[0];
    expect(as.frameRate).toBe("25");
    // Reps don't have frameRate themselves — inherited from AS
    expect(as.representations[0].frameRate).toBeUndefined();
  });
});

describe("validateDash", () => {
  describe("MPD structure checks (DASH-001 through DASH-005)", () => {
    it("DASH-001: warns on wrong namespace", () => {
      const parsed = parseMpd(
        `<MPD xmlns="http://example.com/wrong" profiles="test" minBufferTime="PT2S"><Period></Period></MPD>`,
      );
      const issues = validateDash(parsed);
      expect(issues.find((i) => i.id === "DASH-001")).toBeDefined();
    });

    it("no DASH-001 for correct namespace", () => {
      const parsed = parseMpd(mpd(""));
      const issues = validateDash(parsed);
      expect(issues.find((i) => i.id === "DASH-001")).toBeUndefined();
    });

    it("DASH-002: warns on missing profiles", () => {
      const parsed = parseMpd(
        `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT2S"><Period></Period></MPD>`,
      );
      const issues = validateDash(parsed);
      expect(issues.find((i) => i.id === "DASH-002")).toBeDefined();
    });

    it("DASH-003: warns on missing minBufferTime", () => {
      const parsed = parseMpd(
        `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="test"><Period></Period></MPD>`,
      );
      const issues = validateDash(parsed);
      expect(issues.find((i) => i.id === "DASH-003")).toBeDefined();
    });

    it("DASH-004: info on unexpected type value", () => {
      const parsed = parseMpd(
        `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="test" minBufferTime="PT2S" type="weird"><Period></Period></MPD>`,
      );
      const issues = validateDash(parsed);
      expect(issues.find((i) => i.id === "DASH-004")).toBeDefined();
    });

    it("DASH-005: warns on dynamic MPD missing availabilityStartTime", () => {
      const parsed = parseMpd(
        `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="test" minBufferTime="PT2S" type="dynamic"><Period></Period></MPD>`,
      );
      const issues = validateDash(parsed);
      const issue = issues.find((i) => i.id === "DASH-005");
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("warning");
    });

    it("no DASH-005 for static MPD", () => {
      const parsed = parseMpd(mpd(""));
      const issues = validateDash(parsed);
      expect(issues.find((i) => i.id === "DASH-005")).toBeUndefined();
    });
  });

  describe("DASH-112: Mixed frame rates", () => {
    it("CDP reproduction — 25fps + 50fps in one AS", () => {
      const xml = mpd(
        videoAS(
          rep('id="1" bandwidth="1000000" width="1280" height="720" frameRate="25" codecs="avc1.4d401f"') +
          rep('id="2" bandwidth="2000000" width="1920" height="1080" frameRate="25" codecs="avc1.4d401f"') +
          rep('id="3" bandwidth="3000000" width="1920" height="1080" frameRate="50" codecs="avc1.4d401f"'),
        ),
      );
      const issues = validateDash(parseMpd(xml));
      const dash112 = issues.find((i) => i.id === "DASH-112");
      expect(dash112).toBeDefined();
      expect(dash112!.severity).toBe("error");
      expect(dash112!.detail).toContain("25");
      expect(dash112!.detail).toContain("50");
      expect(dash112!.detail).toContain("1280x720");
      expect(dash112!.specRef).toBe("DASH-IF IOP \u00a73.2.4");
    });

    it("single frame rate — no DASH-112", () => {
      const xml = mpd(
        videoAS(
          rep('id="1" bandwidth="1000000" width="1280" height="720" frameRate="25" codecs="avc1"') +
          rep('id="2" bandwidth="2000000" width="1920" height="1080" frameRate="25" codecs="avc1"'),
        ),
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-112")).toBeUndefined();
    });

    it("separate AdaptationSets — no DASH-112", () => {
      const xml = mpd(
        videoAS(rep('id="1" bandwidth="1000000" width="1280" height="720" frameRate="25" codecs="avc1"')) +
        videoAS(rep('id="2" bandwidth="2000000" width="1920" height="1080" frameRate="50" codecs="avc1"')),
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-112")).toBeUndefined();
    });

    it("fractional frame rates — 30000/1001 vs 30 → DASH-112", () => {
      const xml = mpd(
        videoAS(
          rep('id="1" bandwidth="1000000" width="1280" height="720" frameRate="30000/1001" codecs="avc1"') +
          rep('id="2" bandwidth="2000000" width="1920" height="1080" frameRate="30" codecs="avc1"'),
        ),
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-112")).toBeDefined();
    });

    it("same fractional frame rate — no DASH-112", () => {
      const xml = mpd(
        videoAS(
          rep('id="1" bandwidth="1000000" width="1280" height="720" frameRate="30000/1001" codecs="avc1"') +
          rep('id="2" bandwidth="2000000" width="1920" height="1080" frameRate="30000/1001" codecs="avc1"'),
        ),
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-112")).toBeUndefined();
    });

    it("audio AdaptationSet excluded from DASH-112", () => {
      const xml = mpd(
        `<AdaptationSet contentType="audio" mimeType="audio/mp4">
          <Representation id="1" bandwidth="128000" codecs="mp4a.40.2"/>
          <Representation id="2" bandwidth="256000" codecs="mp4a.40.2"/>
        </AdaptationSet>`,
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-112")).toBeUndefined();
    });

    it("AdaptationSet-level frameRate inheritance — all same → no DASH-112", () => {
      const xml = mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4" frameRate="25">
          <Representation id="1" bandwidth="1000000" width="1280" height="720" codecs="avc1"/>
          <Representation id="2" bandwidth="2000000" width="1920" height="1080" codecs="avc1"/>
        </AdaptationSet>`,
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-112")).toBeUndefined();
    });
  });

  describe("DASH-113: Partial frameRate", () => {
    it("some reps missing frameRate → DASH-113", () => {
      const xml = mpd(
        videoAS(
          rep('id="1" bandwidth="1000000" width="1280" height="720" frameRate="25" codecs="avc1"') +
          rep('id="2" bandwidth="2000000" width="1920" height="1080" codecs="avc1"'),
        ),
      );
      const issues = validateDash(parseMpd(xml));
      const dash113 = issues.find((i) => i.id === "DASH-113");
      expect(dash113).toBeDefined();
      expect(dash113!.severity).toBe("warning");
    });

    it("no frameRate at all → no DASH-112/113", () => {
      const xml = mpd(
        videoAS(
          rep('id="1" bandwidth="1000000" width="1280" height="720" codecs="avc1"') +
          rep('id="2" bandwidth="2000000" width="1920" height="1080" codecs="avc1"'),
        ),
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-112")).toBeUndefined();
      expect(issues.find((i) => i.id === "DASH-113")).toBeUndefined();
    });
  });

  describe("Representation checks", () => {
    it("DASH-102: missing mimeType", () => {
      const xml = mpd(
        `<AdaptationSet contentType="video">
          <Representation id="1" bandwidth="1000000" width="1280" height="720" codecs="avc1"/>
        </AdaptationSet>`,
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-102")).toBeDefined();
    });

    it("DASH-103: missing codecs", () => {
      const xml = mpd(
        videoAS(rep('id="1" bandwidth="1000000" width="1280" height="720"')),
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-103")).toBeDefined();
    });

    it("DASH-104: missing id", () => {
      const xml = mpd(
        videoAS(rep('bandwidth="1000000" width="1280" height="720" codecs="avc1"')),
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-104")).toBeDefined();
    });

    it("DASH-105: missing bandwidth", () => {
      const xml = mpd(
        videoAS(rep('id="1" width="1280" height="720" codecs="avc1"')),
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-105")).toBeDefined();
    });

    it("DASH-106: video missing width/height", () => {
      const xml = mpd(
        videoAS(rep('id="1" bandwidth="1000000" codecs="avc1"')),
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-106")).toBeDefined();
    });
  });
});

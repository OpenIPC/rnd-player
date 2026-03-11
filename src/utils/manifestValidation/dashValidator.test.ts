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

// Realistic CDP MPD fragment — mirrors the real-world manifest from real-world mixed-fps manifest
// that caused A/V desync due to mixed 25fps/50fps in one AdaptationSet.
const CDP_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     xmlns:cenc="urn:mpeg:cenc:2013"
     profiles="urn:mpeg:dash:profile:isoff-live:2011"
     type="static"
     minBufferTime="PT2S"
     mediaPresentationDuration="PT1H23M45S">
  <Period>
    <AdaptationSet id="1" mimeType="video/mp4" segmentAlignment="true"
                   maxWidth="1920" maxHeight="1080" maxFrameRate="50"
                   contentType="video">
      <Representation id="1"  width="480"  height="270"  bandwidth="497200"  frameRate="25" codecs="avc1.4D4015"/>
      <Representation id="8"  width="480"  height="270"  bandwidth="498117"  frameRate="50" codecs="avc1.4D401E"/>
      <Representation id="2"  width="640"  height="360"  bandwidth="695620"  frameRate="25" codecs="avc1.4D401E"/>
      <Representation id="9"  width="640"  height="360"  bandwidth="696821"  frameRate="50" codecs="avc1.4D401F"/>
      <Representation id="3"  width="864"  height="486"  bandwidth="993241"  frameRate="25" codecs="avc1.4D401E"/>
      <Representation id="10" width="864"  height="486"  bandwidth="994442"  frameRate="50" codecs="avc1.4D401F"/>
      <Representation id="4"  width="1024" height="576"  bandwidth="1492062" frameRate="25" codecs="avc1.4D401F"/>
      <Representation id="11" width="1024" height="576"  bandwidth="1493263" frameRate="50" codecs="avc1.4D401F"/>
      <Representation id="5"  width="1280" height="720"  bandwidth="2489803" frameRate="25" codecs="avc1.640020"/>
      <Representation id="12" width="1280" height="720"  bandwidth="2491004" frameRate="50" codecs="avc1.640020"/>
      <Representation id="6"  width="1600" height="900"  bandwidth="3989524" frameRate="25" codecs="avc1.640028"/>
      <Representation id="13" width="1600" height="900"  bandwidth="3990725" frameRate="50" codecs="avc1.640028"/>
      <Representation id="7"  width="1920" height="1080" bandwidth="4992289" frameRate="25" codecs="avc1.640028"/>
      <Representation id="14" width="1920" height="1080" bandwidth="6487695" frameRate="50" codecs="avc1.64002A"/>
    </AdaptationSet>
    <AdaptationSet id="2" mimeType="audio/mp4" contentType="audio" lang="ru">
      <Representation id="15" bandwidth="128701" codecs="mp4a.40.2" audioSamplingRate="48000"/>
    </AdaptationSet>
    <AdaptationSet id="3" mimeType="audio/mp4" contentType="audio" lang="ru">
      <Representation id="16" bandwidth="128687" codecs="mp4a.40.2" audioSamplingRate="48000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe("Mixed frame rate regression — mixed frame rate A/V desync (mixed frame rate A/V desync)", () => {
  it("detects DASH-112 error for 25fps/50fps mix in single AdaptationSet", () => {
    const issues = validateDash(parseMpd(CDP_MPD));
    const dash112 = issues.filter((i) => i.id === "DASH-112");
    expect(dash112).toHaveLength(1);
    expect(dash112[0].severity).toBe("error");
    expect(dash112[0].category).toBe("Manifest Structure");
    expect(dash112[0].location).toBe("Period[0] > AdaptationSet[0]");
    expect(dash112[0].specRef).toContain("DASH-IF IOP");
    // Verify both frame rate groups are listed in detail
    expect(dash112[0].detail).toContain("25");
    expect(dash112[0].detail).toContain("50");
    // Verify resolutions from both groups appear
    expect(dash112[0].detail).toContain("480x270");
    expect(dash112[0].detail).toContain("1920x1080");
  });

  it("does not flag audio AdaptationSets", () => {
    const issues = validateDash(parseMpd(CDP_MPD));
    // DASH-112 should only fire for the video AS, not audio
    const dash112 = issues.filter((i) => i.id === "DASH-112");
    expect(dash112).toHaveLength(1);
    expect(dash112[0].location).toBe("Period[0] > AdaptationSet[0]");
  });

  it("parses all 14 video representations from mixed-fps manifest", () => {
    const parsed = parseMpd(CDP_MPD);
    const videoAS = parsed.periods[0].adaptationSets[0];
    expect(videoAS.representations).toHaveLength(14);
  });
});

describe("parseMpd — SegmentTimeline parsing", () => {
  it("extracts segmentTimelineCount from AS-level SegmentTemplate", () => {
    const xml = mpd(
      `<AdaptationSet contentType="video" mimeType="video/mp4">
        <SegmentTemplate timescale="12800" media="seg-$Number$.m4s" initialization="init.m4s">
          <SegmentTimeline>
            <S t="0" d="25600" r="99"/>
            <S d="12800"/>
          </SegmentTimeline>
        </SegmentTemplate>
        <Representation id="1" bandwidth="1000000" width="1280" height="720" codecs="avc1"/>
      </AdaptationSet>`,
    );
    const parsed = parseMpd(xml);
    expect(parsed.periods[0].adaptationSets[0].segmentTimelineCount).toBe(2);
  });

  it("detects empty SegmentTimeline (count = 0)", () => {
    const xml = mpd(
      `<AdaptationSet contentType="video" mimeType="video/mp4">
        <SegmentTemplate timescale="12800" media="seg-$Number$.m4s" initialization="init.m4s">
          <SegmentTimeline></SegmentTimeline>
        </SegmentTemplate>
        <Representation id="1" bandwidth="1000000" width="1280" height="720" codecs="avc1"/>
      </AdaptationSet>`,
    );
    const parsed = parseMpd(xml);
    expect(parsed.periods[0].adaptationSets[0].segmentTimelineCount).toBe(0);
  });

  it("returns undefined when no SegmentTemplate", () => {
    const xml = mpd(
      videoAS(rep('id="1" bandwidth="1000000" width="1280" height="720" codecs="avc1"')),
    );
    const parsed = parseMpd(xml);
    expect(parsed.periods[0].adaptationSets[0].segmentTimelineCount).toBeUndefined();
  });

  it("counts multiple <S> entries", () => {
    const xml = mpd(
      `<AdaptationSet contentType="audio" mimeType="audio/mp4">
        <SegmentTemplate timescale="48000" media="seg-$Number$.m4s" initialization="init.m4s">
          <SegmentTimeline>
            <S t="0" d="96000" r="2863"/>
          </SegmentTimeline>
        </SegmentTemplate>
        <Representation id="1" bandwidth="128000" codecs="mp4a.40.2"/>
      </AdaptationSet>`,
    );
    const parsed = parseMpd(xml);
    expect(parsed.periods[0].adaptationSets[0].segmentTimelineCount).toBe(1);
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

  describe("DASH-007: Empty SegmentTimeline", () => {
    it("flags empty SegmentTimeline with Representations → error", () => {
      const xml = mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate timescale="12800" media="seg-$Number$.m4s" initialization="init.m4s">
            <SegmentTimeline></SegmentTimeline>
          </SegmentTemplate>
          <Representation id="1" bandwidth="1000000" width="1280" height="720" codecs="avc1.4D401F"/>
          <Representation id="2" bandwidth="2000000" width="1920" height="1080" codecs="avc1.640028"/>
        </AdaptationSet>`,
      );
      const issues = validateDash(parseMpd(xml));
      const dash007 = issues.find((i) => i.id === "DASH-007");
      expect(dash007).toBeDefined();
      expect(dash007!.severity).toBe("error");
      expect(dash007!.message).toContain("empty SegmentTimeline");
      expect(dash007!.message).toContain("2 Representation(s)");
      expect(dash007!.detail).toContain("hang");
    });

    it("no flag when SegmentTimeline has entries", () => {
      const xml = mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate timescale="12800" media="seg-$Number$.m4s" initialization="init.m4s">
            <SegmentTimeline>
              <S t="0" d="25600" r="99"/>
            </SegmentTimeline>
          </SegmentTemplate>
          <Representation id="1" bandwidth="1000000" width="1280" height="720" codecs="avc1"/>
        </AdaptationSet>`,
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-007")).toBeUndefined();
    });

    it("no flag when no SegmentTemplate at all (SegmentBase addressing)", () => {
      const xml = mpd(
        videoAS(rep('id="1" bandwidth="1000000" width="1280" height="720" codecs="avc1"')),
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-007")).toBeUndefined();
    });

    it("no flag when AdaptationSet has 0 Representations", () => {
      const xml = mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate timescale="12800" media="seg-$Number$.m4s" initialization="init.m4s">
            <SegmentTimeline></SegmentTimeline>
          </SegmentTemplate>
        </AdaptationSet>`,
      );
      const issues = validateDash(parseMpd(xml));
      expect(issues.find((i) => i.id === "DASH-007")).toBeUndefined();
    });

    it("Mixed frame rate regression: video empty timeline + audio populated → flags only video AS", () => {
      const xml = mpd(
        `<AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate timescale="12800" media="v-seg-$Number$.m4s" initialization="v-init.m4s">
            <SegmentTimeline></SegmentTimeline>
          </SegmentTemplate>
          <Representation id="1" bandwidth="1000000" width="1280" height="720" codecs="avc1.4D401F"/>
          <Representation id="2" bandwidth="2000000" width="1920" height="1080" codecs="avc1.640028"/>
        </AdaptationSet>
        <AdaptationSet contentType="audio" mimeType="audio/mp4">
          <SegmentTemplate timescale="48000" media="a-seg-$Number$.m4s" initialization="a-init.m4s">
            <SegmentTimeline>
              <S t="0" d="96000" r="2863"/>
            </SegmentTimeline>
          </SegmentTemplate>
          <Representation id="3" bandwidth="128000" codecs="mp4a.40.2"/>
        </AdaptationSet>`,
      );
      const issues = validateDash(parseMpd(xml));
      const dash007 = issues.filter((i) => i.id === "DASH-007");
      expect(dash007).toHaveLength(1);
      expect(dash007[0].message).toContain("Video");
      expect(dash007[0].location).toBe("Period[0] > AdaptationSet[0]");
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

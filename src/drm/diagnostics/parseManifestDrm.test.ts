import { describe, it, expect } from "vitest";
import { parseManifestDrm } from "./parseManifestDrm";

describe("parseManifestDrm", () => {
  it("detects DASH manifest type", () => {
    const { info } = parseManifestDrm('<?xml version="1.0"?><MPD></MPD>');
    expect(info.type).toBe("dash");
  });

  it("extracts ContentProtection with Widevine schemeIdUri", () => {
    const mpd = `<?xml version="1.0"?>
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013">
        <Period>
          <AdaptationSet>
            <ContentProtection
              schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
              cenc:default_KID="a1b2c3d4-e5f6-0718-2930-41526374a5b6" />
          </AdaptationSet>
        </Period>
      </MPD>`;
    const { info } = parseManifestDrm(mpd);
    expect(info.contentProtections).toHaveLength(1);
    expect(info.contentProtections[0].systemName).toBe("Widevine");
    expect(info.contentProtections[0].defaultKid).toBe("a1b2c3d4e5f60718293041526374a5b6");
  });

  it("extracts multiple ContentProtection elements", () => {
    const mpd = `<?xml version="1.0"?>
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013">
        <Period>
          <AdaptationSet>
            <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="aabb0000-0000-0000-0000-000000000001" />
            <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />
            <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95" />
          </AdaptationSet>
        </Period>
      </MPD>`;
    const { info } = parseManifestDrm(mpd);
    expect(info.contentProtections).toHaveLength(3);
    expect(info.contentProtections[0].systemName).toBe("CENC (mp4protection)");
    expect(info.contentProtections[1].systemName).toBe("Widevine");
    expect(info.contentProtections[2].systemName).toBe("PlayReady");
  });

  it("detects HLS manifest type", () => {
    const { info } = parseManifestDrm("#EXTM3U\n#EXT-X-VERSION:7\n");
    expect(info.type).toBe("hls");
  });

  it("extracts EXT-X-KEY tags from HLS", () => {
    const hls = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1",IV=0x00000000000000000000000000000001
#EXTINF:6.0,
segment1.ts`;
    const { info } = parseManifestDrm(hls);
    expect(info.hlsKeys).toHaveLength(1);
    expect(info.hlsKeys[0].method).toBe("SAMPLE-AES-CTR");
    expect(info.hlsKeys[0].uri).toBe("skd://key-id");
    expect(info.hlsKeys[0].keyformat).toBe("com.apple.streamingkeydelivery");
    expect(info.hlsKeys[0].keyformatVersions).toBe("1");
    expect(info.hlsKeys[0].iv).toBe("0x00000000000000000000000000000001");
  });

  it("extracts EXT-X-SESSION-KEY tags", () => {
    const hls = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="https://license.example.com",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"`;
    const { info } = parseManifestDrm(hls);
    expect(info.hlsKeys).toHaveLength(1);
    expect(info.hlsKeys[0].method).toBe("SAMPLE-AES");
    expect(info.hlsKeys[0].keyformat).toBe("urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed");
  });

  it("returns unknown for unrecognized manifest", () => {
    const { info } = parseManifestDrm("just some random text");
    expect(info.type).toBe("unknown");
    expect(info.contentProtections).toHaveLength(0);
    expect(info.hlsKeys).toHaveLength(0);
  });

  it("returns unknown for empty input", () => {
    const { info } = parseManifestDrm("");
    expect(info.type).toBe("unknown");
  });

  it("handles MPD without ContentProtection", () => {
    const mpd = `<?xml version="1.0"?>
      <MPD><Period><AdaptationSet></AdaptationSet></Period></MPD>`;
    const { info } = parseManifestDrm(mpd);
    expect(info.type).toBe("dash");
    expect(info.contentProtections).toHaveLength(0);
  });

  it("handles HLS without key tags", () => {
    const hls = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:6.0,
segment1.ts`;
    const { info } = parseManifestDrm(hls);
    expect(info.type).toBe("hls");
    expect(info.hlsKeys).toHaveLength(0);
  });

  it("deduplicates identical ContentProtection across AdaptationSets", () => {
    const mpd = `<?xml version="1.0"?>
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013">
        <Period>
          <AdaptationSet contentType="video">
            <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="aabb0000-0000-0000-0000-000000000001" />
            <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />
            <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95" />
          </AdaptationSet>
          <AdaptationSet contentType="audio">
            <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="aabb0000-0000-0000-0000-000000000001" />
            <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />
            <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95" />
          </AdaptationSet>
          <AdaptationSet contentType="audio" lang="en">
            <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="aabb0000-0000-0000-0000-000000000001" />
            <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />
            <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95" />
          </AdaptationSet>
        </Period>
      </MPD>`;
    const { info } = parseManifestDrm(mpd);
    // 3 unique systems, not 9 (3 per AdaptationSet × 3 sets)
    expect(info.contentProtections).toHaveLength(3);
    expect(info.contentProtections[0].systemName).toBe("CENC (mp4protection)");
    expect(info.contentProtections[1].systemName).toBe("Widevine");
    expect(info.contentProtections[2].systemName).toBe("PlayReady");
  });

  it("keeps ContentProtection entries with different KIDs", () => {
    const mpd = `<?xml version="1.0"?>
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013">
        <Period>
          <AdaptationSet contentType="video">
            <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="aaaa0000-0000-0000-0000-000000000001" />
          </AdaptationSet>
          <AdaptationSet contentType="audio">
            <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="bbbb0000-0000-0000-0000-000000000002" />
          </AdaptationSet>
        </Period>
      </MPD>`;
    const { info } = parseManifestDrm(mpd);
    // Different KIDs → not deduplicated
    expect(info.contentProtections).toHaveLength(2);
  });

  it("extracts robustness attribute", () => {
    const mpd = `<?xml version="1.0"?>
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
        <Period>
          <AdaptationSet>
            <ContentProtection
              schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
              robustness="SW_SECURE_CRYPTO" />
          </AdaptationSet>
        </Period>
      </MPD>`;
    const { info } = parseManifestDrm(mpd);
    expect(info.contentProtections[0].robustness).toBe("SW_SECURE_CRYPTO");
  });
});

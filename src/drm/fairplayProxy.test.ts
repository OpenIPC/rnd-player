import { describe, it, expect } from "vitest";
import {
  hasFairPlayKey,
  deriveFairPlayUrl,
  deriveFairPlayCertUrl,
} from "./fairplayProxy";
import type { ManifestDrmInfo, HlsKeyInfo } from "./diagnostics/types";

describe("hasFairPlayKey", () => {
  it("returns true when FairPlay key format is present", () => {
    const info: ManifestDrmInfo = {
      type: "hls",
      contentProtections: [],
      hlsKeys: [
        {
          method: "SAMPLE-AES",
          uri: "skd://content-id-123",
          keyformat: "com.apple.streamingkeydelivery",
          keyformatVersions: "1",
        } as HlsKeyInfo,
      ],
    };
    expect(hasFairPlayKey(info)).toBe(true);
  });

  it("returns true with mixed-case keyformat", () => {
    const info: ManifestDrmInfo = {
      type: "hls",
      contentProtections: [],
      hlsKeys: [
        {
          method: "SAMPLE-AES",
          uri: "skd://content-id-123",
          keyformat: "COM.APPLE.STREAMINGKEYDELIVERY",
        } as HlsKeyInfo,
      ],
    };
    expect(hasFairPlayKey(info)).toBe(true);
  });

  it("returns false when no FairPlay key entry", () => {
    const info: ManifestDrmInfo = {
      type: "hls",
      contentProtections: [],
      hlsKeys: [
        {
          method: "AES-128",
          uri: "https://example.com/key",
        } as HlsKeyInfo,
      ],
    };
    expect(hasFairPlayKey(info)).toBe(false);
  });

  it("returns false with empty hlsKeys", () => {
    const info: ManifestDrmInfo = {
      type: "hls",
      contentProtections: [],
      hlsKeys: [],
    };
    expect(hasFairPlayKey(info)).toBe(false);
  });
});

describe("deriveFairPlayUrl", () => {
  it("appends /fairplay to license URL", () => {
    expect(deriveFairPlayUrl("https://drm.example.com/license")).toBe(
      "https://drm.example.com/license/fairplay",
    );
  });

  it("strips trailing slash before appending", () => {
    expect(deriveFairPlayUrl("https://drm.example.com/license/")).toBe(
      "https://drm.example.com/license/fairplay",
    );
  });

  it("strips multiple trailing slashes", () => {
    expect(deriveFairPlayUrl("https://drm.example.com/license///")).toBe(
      "https://drm.example.com/license/fairplay",
    );
  });
});

describe("deriveFairPlayCertUrl", () => {
  it("appends /fairplay/cert to license URL", () => {
    expect(deriveFairPlayCertUrl("https://drm.example.com/license")).toBe(
      "https://drm.example.com/license/fairplay/cert",
    );
  });

  it("strips trailing slash before appending", () => {
    expect(deriveFairPlayCertUrl("https://drm.example.com/license/")).toBe(
      "https://drm.example.com/license/fairplay/cert",
    );
  });
});


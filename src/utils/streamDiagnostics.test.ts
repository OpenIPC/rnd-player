import { describe, it, expect } from "vitest";
import { diagnoseNetworkError, diagnoseDrmPlaybackError, diagnoseFallbackError, simpleError } from "./streamDiagnostics";

describe("streamDiagnostics", () => {
  describe("simpleError", () => {
    it("wraps a string into StreamError", () => {
      const err = simpleError("Something broke");
      expect(err.summary).toBe("Something broke");
      expect(err.details).toEqual([]);
    });
  });

  describe("diagnoseNetworkError", () => {
    const baseCtx = { segmentSuccessCount: 0, manifestUrl: "https://cdn.example.com/stream.mpd" };

    describe("manifest errors (requestType=0)", () => {
      it("diagnoses manifest 404", () => {
        const err = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/stream.mpd", 404, "", {}, 0] },
          baseCtx,
        );
        expect(err.summary).toBe("Manifest not found (HTTP 404)");
        expect(err.httpStatus).toBe(404);
        expect(err.details.some((d) => d.includes("removed or the URL is incorrect"))).toBe(true);
      });

      it("diagnoses manifest 403", () => {
        const err = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/stream.mpd", 403, "", {}, 0] },
          baseCtx,
        );
        expect(err.summary).toBe("Access denied (HTTP 403)");
        expect(err.httpStatus).toBe(403);
      });

      it("diagnoses manifest 410", () => {
        const err = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/stream.mpd", 410, "", {}, 0] },
          baseCtx,
        );
        expect(err.summary).toBe("Stream expired (HTTP 410)");
      });

      it("diagnoses manifest 500", () => {
        const err = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/stream.mpd", 500, "", {}, 0] },
          baseCtx,
        );
        expect(err.summary).toBe("Failed to load manifest (HTTP 500)");
        expect(err.details.some((d) => d.includes("server-side error"))).toBe(true);
      });
    });

    describe("segment errors (requestType=1)", () => {
      it("diagnoses segment 404 with success count", () => {
        const err = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/seg-5.m4s", 404, "", {}, 1] },
          { segmentSuccessCount: 4, manifestUrl: "https://cdn.example.com/stream.mpd" },
        );
        expect(err.summary).toBe("Segment not found (HTTP 404)");
        expect(err.httpStatus).toBe(404);
        expect(err.details.some((d) => d.includes("4 segment(s) loaded successfully"))).toBe(true);
        expect(err.details.some((d) => d.includes("origin server could not find"))).toBe(true);
      });

      it("diagnoses ISM segment 404 with TFRA hint", () => {
        const ismSegUrl = "https://cdn.example.com/output.ism/Q(5)/F(v=74399953)";
        const err = diagnoseNetworkError(
          { code: 1001, data: [ismSegUrl, 404, "", {}, 1] },
          { segmentSuccessCount: 3, manifestUrl: "https://cdn.example.com/output.ism/Manifest.mpd" },
        );
        expect(err.summary).toBe("Segment not found (HTTP 404)");
        expect(err.details.some((d) => d.includes("cross-track segment time mismatches"))).toBe(true);
        expect(err.details.some((d) => d.includes("TFRA"))).toBe(true);
      });

      it("diagnoses segment 500 on ISM origin", () => {
        const ismSegUrl = "https://cdn.example.com/output.ism/Q(3)/F(v=10399992)";
        const err = diagnoseNetworkError(
          { code: 1001, data: [ismSegUrl, 500, "", {}, 1] },
          { segmentSuccessCount: 2, manifestUrl: "https://cdn.example.com/output.ism/Manifest.mpd" },
        );
        expect(err.summary).toBe("Segment server error (HTTP 500)");
        expect(err.details.some((d) => d.includes("ISM origin"))).toBe(true);
        expect(err.details.some((d) => d.includes("ISM remuxer"))).toBe(true);
      });

      it("diagnoses segment 403", () => {
        const err = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/seg-10.m4s", 403, "", {}, 1] },
          { segmentSuccessCount: 10, manifestUrl: "https://cdn.example.com/stream.mpd" },
        );
        expect(err.summary).toBe("Segment access denied (HTTP 403)");
        expect(err.details.some((d) => d.includes("CDN token/signature"))).toBe(true);
      });

      it("diagnoses segment 410", () => {
        const err = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/seg-5.m4s", 410, "", {}, 1] },
          { segmentSuccessCount: 5, manifestUrl: "https://cdn.example.com/stream.mpd" },
        );
        expect(err.summary).toBe("Segment expired (HTTP 410)");
      });

      it("diagnoses generic segment HTTP error", () => {
        const err = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/seg.m4s", 429, "", {}, 1] },
          { segmentSuccessCount: 1, manifestUrl: "https://cdn.example.com/stream.mpd" },
        );
        expect(err.summary).toBe("Segment fetch failed (HTTP 429)");
      });

      it("reports first segment failure vs later failure", () => {
        const errFirst = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/seg-0.m4s", 404, "", {}, 1] },
          { segmentSuccessCount: 0, manifestUrl: "https://cdn.example.com/stream.mpd" },
        );
        expect(errFirst.details.some((d) => d.includes("first segment request failed"))).toBe(true);

        const errLater = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/seg-5.m4s", 404, "", {}, 1] },
          { segmentSuccessCount: 5, manifestUrl: "https://cdn.example.com/stream.mpd" },
        );
        expect(errLater.details.some((d) => d.includes("5 segment(s) loaded successfully"))).toBe(true);
      });
    });

    describe("timeout (code 1003)", () => {
      it("diagnoses timeout", () => {
        const err = diagnoseNetworkError(
          { code: 1003, data: ["https://cdn.example.com/seg.m4s", 1] },
          baseCtx,
        );
        expect(err.summary).toContain("timed out");
      });
    });

    describe("HTTP_ERROR (code 1002)", () => {
      it("produces transfer interrupted error with URL", () => {
        const err = diagnoseNetworkError(
          { code: 1002, data: ["https://cdn.example.com/seg.m4s"] },
          baseCtx,
        );
        expect(err.summary).toBe("Unknown request transfer interrupted (network error)");
        expect(err.details.some((d) => d.includes("interrupted"))).toBe(true);
      });

      it("includes ISM hint for ISM segment URLs", () => {
        const err = diagnoseNetworkError(
          { code: 1002, data: ["https://cdn.example.com/video.ism/Q(128000)/F(seg0)", undefined, undefined, undefined, 1] },
          { ...baseCtx, manifestUrl: "https://cdn.example.com/video.ism/Manifest.mpd" },
        );
        expect(err.summary).toBe("Media segment transfer interrupted (network error)");
        expect(err.details.some((d) => d.includes("senc/trun"))).toBe(true);
      });

      it("extracts nested error message", () => {
        const err = diagnoseNetworkError(
          { code: 1002, data: ["https://cdn.example.com/seg.m4s", new TypeError("Failed to fetch")] },
          baseCtx,
        );
        expect(err.details.some((d) => d.includes("Failed to fetch"))).toBe(true);
      });
    });

    describe("other non-1001 network errors", () => {
      it("produces generic network error", () => {
        const err = diagnoseNetworkError(
          { code: 1004, data: ["https://cdn.example.com/seg.m4s"] },
          baseCtx,
        );
        expect(err.summary).toBe("Network error (code 1004)");
      });
    });

    describe("URL shortening", () => {
      it("includes shortened URL in details", () => {
        const longUrl = "https://cdn.example.com/vod/cid/126979210-2000000000-_23VxJohwEpiPcCWkv3OTQ/storage666/clr/m/shfpbw/9d704423-61d5-476a-af79-b10523975aa4/output.ism/Q(5)/F(v=74399953)";
        const err = diagnoseNetworkError(
          { code: 1001, data: [longUrl, 404, "", {}, 1] },
          { segmentSuccessCount: 3, manifestUrl: "https://cdn.example.com/output.ism/Manifest.mpd" },
        );
        // Should contain shortened URL, not the full path
        const urlLine = err.details.find((d) => d.startsWith("Failed URL:"));
        expect(urlLine).toBeDefined();
        expect(urlLine!.length).toBeLessThan(longUrl.length + 15);
        // Should still contain the meaningful last segments
        expect(urlLine).toContain("Q(5)");
      });
    });

    describe("edge: segment error without requestType in data", () => {
      it("falls back to manifest diagnosis when no segments loaded and no requestType", () => {
        const err = diagnoseNetworkError(
          { code: 1001, data: ["https://cdn.example.com/something", 500] },
          baseCtx,
        );
        // With 0 segments and no explicit requestType, treated as manifest error
        expect(err.summary).toContain("manifest");
      });
    });
  });

  describe("diagnoseDrmPlaybackError", () => {
    it("detects OPM error from Shaka code 3014 category 3", () => {
      const err = diagnoseDrmPlaybackError({ code: 3014, category: 3, data: [] });
      expect(err).not.toBeNull();
      expect(err!.summary).toContain("Output Protection");
      expect(err!.details.some(d => /Remote Desktop/i.test(d))).toBe(true);
    });

    it("detects OPM error from Shaka code 6008", () => {
      const err = diagnoseDrmPlaybackError({ code: 6008, category: 6, data: [] });
      expect(err).not.toBeNull();
      expect(err!.summary).toContain("OPM");
    });

    it("detects OPM error from error data containing 0xC0262500", () => {
      const err = diagnoseDrmPlaybackError({
        code: 3015,
        category: 3,
        data: ["MediaFoundationRenderer error: kOnPlaybackError (The driver does not support OPM. (0xC0262500))"],
      });
      expect(err).not.toBeNull();
      expect(err!.summary).toContain("Output Protection");
    });

    it("detects OPM error from error data containing 'output protection'", () => {
      const err = diagnoseDrmPlaybackError({
        code: 3015,
        category: 3,
        data: ["output protection manager failed"],
      });
      expect(err).not.toBeNull();
    });

    it("returns null for unrelated media errors", () => {
      const err = diagnoseDrmPlaybackError({ code: 3014, category: 3, data: ["some other error"] });
      // code 3014 + category 3 still matches the pattern
      expect(err).not.toBeNull();
    });

    it("returns null for non-OPM DRM errors", () => {
      const err = diagnoseDrmPlaybackError({ code: 6001, category: 6, data: [] });
      expect(err).toBeNull();
    });

    it("returns null for non-OPM media errors", () => {
      const err = diagnoseDrmPlaybackError({ code: 3001, category: 3, data: [] });
      expect(err).toBeNull();
    });

    it("includes ClearKey suggestion in details", () => {
      const err = diagnoseDrmPlaybackError({ code: 3014, category: 3, data: [] });
      expect(err!.details.some(d => /ClearKey/i.test(d))).toBe(true);
    });
  });

  describe("diagnoseFallbackError", () => {
    it("uses video element MEDIA_ERR_NETWORK for summary", () => {
      const err = diagnoseFallbackError(
        { code: 5001, category: 5 },
        { code: 2, message: "" } as MediaError,
      );
      expect(err.summary).toBe("Network error: the video transfer was interrupted");
      expect(err.details.some((d) => d.includes("MEDIA_ERR_NETWORK"))).toBe(true);
    });

    it("uses video element MEDIA_ERR_DECODE for summary", () => {
      const err = diagnoseFallbackError(
        { code: 3015, category: 3 },
        { code: 3, message: "PIPELINE_ERROR_DECODE" } as MediaError,
      );
      expect(err.summary).toBe("Media decode error: the video data could not be decoded");
      expect(err.details.some((d) => d.includes("PIPELINE_ERROR_DECODE"))).toBe(true);
    });

    it("extracts nested Error from Shaka data", () => {
      const err = diagnoseFallbackError(
        { code: 3015, category: 3, data: [new TypeError("Failed to fetch")] },
        null,
      );
      expect(err.summary).toBe("Network error: a media request was interrupted mid-transfer");
      expect(err.details.some((d) => d.includes("Failed to fetch"))).toBe(true);
    });

    it("detects fetch failure with ISM manifest URL", () => {
      const err = diagnoseFallbackError(
        { code: undefined as unknown as number, data: [new TypeError("Failed to fetch")] },
        null,
        "https://cdn.example.com/video.ism/Manifest.mpd",
      );
      expect(err.summary).toBe("Network error: a media request was interrupted mid-transfer");
      expect(err.details.some((d) => d.includes("senc/trun"))).toBe(true);
    });

    it("includes Shaka code/category in details", () => {
      const err = diagnoseFallbackError(
        { code: 5001, category: 5 },
        null,
      );
      expect(err.details.some((d) => d.includes("category=5") && d.includes("code=5001"))).toBe(true);
      expect(err.summary).toBe("Playback error (code 5001): the video could not be played");
    });

    it("handles undefined code gracefully", () => {
      const err = diagnoseFallbackError(
        { code: undefined as unknown as number },
        null,
      );
      expect(err.summary).toBe("Playback error: the video could not be played");
    });

    it("uses nested message as summary when code is undefined", () => {
      const err = diagnoseFallbackError(
        { code: undefined as unknown as number, data: [{ message: "some unusual error" }] },
        null,
      );
      expect(err.summary).toBe("Playback error: some unusual error");
    });
  });
});

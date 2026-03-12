import { describe, it, expect } from "vitest";
import { formatTextReport } from "./reportExport";
import type { DrmDiagnosticsState } from "./types";
import type { EmeEvent } from "./emeCapture";
import type { DiagnosticResult } from "./silentFailures";
import type { CompatReport } from "./compatChecker";

function emptyState(): DrmDiagnosticsState {
  return { manifest: null, initSegment: null };
}

function fullState(): DrmDiagnosticsState {
  return {
    manifest: {
      type: "dash",
      contentProtections: [
        { schemeIdUri: "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", systemName: "Widevine", defaultKid: "a1b2c3d4" },
        { schemeIdUri: "urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b", systemName: "ClearKey" },
      ],
      hlsKeys: [],
    },
    initSegment: {
      tracks: [
        { trackId: 1, scheme: "cenc", defaultKid: "a1b2c3d4", defaultIvSize: 8, defaultConstantIv: null },
      ],
      psshBoxes: [],
    },
    manifestPsshBoxes: [
      {
        systemId: "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",
        systemName: "Widevine",
        version: 0,
        keyIds: ["a1b2c3d4"],
        data: new Uint8Array(0),
        decoded: { keyIds: ["a1b2c3d4"], provider: "example" } as import("./types").WidevinePssh,
        source: "manifest",
      },
    ],
    emeEvents: [
      { id: 1, timestamp: 1000, type: "access-request", detail: "ClearKey EME probe" },
      { id: 2, timestamp: 1012, type: "access-granted", detail: "ClearKey EME supported", success: true, duration: 12 },
      { id: 3, timestamp: 1013, type: "keys-set", detail: "ClearKey configured", duration: 1 },
    ] as EmeEvent[],
    licenseExchanges: [
      { id: 1, timestamp: 2000, drmSystem: "clearkey", url: "https://license.example.com/", method: "POST", requestHeaders: {}, requestBody: "{}", responseStatus: 200, durationMs: 142 },
    ],
    diagnostics: [
      { id: "DRM-001", severity: "warning", title: "Test warning", detail: "Some detail", timestamp: 3000 },
    ] as DiagnosticResult[],
    compatibility: {
      results: [
        { id: "widevine", label: "Widevine", keySystem: "com.widevine.alpha", supported: true, robustness: "SW_SECURE_CRYPTO" },
        { id: "playready", label: "PlayReady", keySystem: "com.microsoft.playready", supported: false },
      ],
      emeAvailable: true,
      secureContext: true,
      softwareDecryptAvailable: true,
      timestamp: 4000,
    } as CompatReport,
  };
}

describe("formatTextReport", () => {
  it("produces expected sections with full state", () => {
    const text = formatTextReport(fullState(), "https://example.com/stream.mpd");
    expect(text).toContain("DRM Diagnostics Report");
    expect(text).toContain("URL: https://example.com/stream.mpd");
    expect(text).toContain("Type: DASH");
    expect(text).toContain("Widevine");
    expect(text).toContain("ClearKey");
    expect(text).toContain("Track 1: cenc");
    expect(text).toContain("PSSH:");
    expect(text).toContain("EME Events (3)");
    expect(text).toContain("License Exchanges (1)");
    expect(text).toContain("Diagnostics");
    expect(text).toContain("Compatibility");
  });

  it("produces minimal report with empty state", () => {
    const text = formatTextReport(emptyState());
    expect(text).toContain("DRM Diagnostics Report");
    expect(text).toContain("No DRM detected");
    expect(text).toContain("No events captured");
    expect(text).toContain("No exchanges captured");
    expect(text).toContain("No issues detected");
    expect(text).toContain("Not probed");
  });

  it("formats EME events with relative timestamps", () => {
    const state = { ...emptyState(), emeEvents: fullState().emeEvents };
    const text = formatTextReport(state);
    expect(text).toContain("00:00.000");
    expect(text).toContain("00:00.012");
    expect(text).toContain("ACCESS?");
    expect(text).toContain("ACCESS+");
    expect(text).toContain("(+12ms)");
  });

  it("shows 'No issues' when diagnostics array is empty", () => {
    const state = { ...emptyState(), diagnostics: [] };
    const text = formatTextReport(state);
    expect(text).toContain("\u2713 No issues detected");
  });

  it("shows severity icons when diagnostics are populated", () => {
    const state = {
      ...emptyState(),
      diagnostics: [
        { id: "DRM-001", severity: "error" as const, title: "Error title", detail: "Error detail", timestamp: 1 },
        { id: "DRM-002", severity: "warning" as const, title: "Warning title", detail: "", timestamp: 2 },
        { id: "DRM-003", severity: "info" as const, title: "Info title", detail: "", timestamp: 3 },
      ],
    };
    const text = formatTextReport(state);
    expect(text).toContain("\u25CF DRM-001");  // ● error
    expect(text).toContain("\u25B2 DRM-002");  // ▲ warning
    expect(text).toContain("\u25CB DRM-003");  // ○ info
    expect(text).toContain("Error detail");
  });

  it("formats compatibility section as table-like output", () => {
    const state = { ...emptyState(), compatibility: fullState().compatibility };
    const text = formatTextReport(state);
    expect(text).toContain("Widevine");
    expect(text).toContain("Supported");
    expect(text).toContain("SW_SECURE_CRYPTO");
    expect(text).toContain("com.widevine.alpha");
    expect(text).toContain("PlayReady");
    expect(text).toContain("Not found");
    expect(text).toContain("EME: available");
    expect(text).toContain("Secure context: yes");
    expect(text).toContain("SW decrypt: available");
  });

  it("omits URL line when manifestUrl is not provided", () => {
    const text = formatTextReport(emptyState());
    expect(text).not.toContain("URL:");
  });

  it("includes license exchange details", () => {
    const state = { ...emptyState(), licenseExchanges: fullState().licenseExchanges };
    const text = formatTextReport(state);
    expect(text).toContain("CLEARKEY");
    expect(text).toContain("https://license.example.com/");
    expect(text).toContain("200");
    expect(text).toContain("142ms");
  });

  it("includes PSSH summary with provider", () => {
    const state = fullState();
    const text = formatTextReport(state);
    expect(text).toContain('provider "example"');
  });

  it("includes HLS keys when present", () => {
    const state: DrmDiagnosticsState = {
      manifest: {
        type: "hls",
        contentProtections: [],
        hlsKeys: [{ method: "AES-128", uri: "https://key.example.com/key", iv: "0x00000001" }],
      },
      initSegment: null,
    };
    const text = formatTextReport(state);
    expect(text).toContain("HLS Key: AES-128");
    expect(text).toContain("https://key.example.com/key");
  });
});

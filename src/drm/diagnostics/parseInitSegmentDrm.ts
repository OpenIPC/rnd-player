/**
 * Parse DRM metadata from an init segment (ISOBMFF moov).
 *
 * Reuses utilities from cencDecrypt.ts to extract tenc/scheme info
 * and findAllPsshBoxes for PSSH box discovery.
 */

import { extractScheme, extractTenc } from "../../workers/cencDecrypt";
import { findAllPsshBoxes } from "./psshDecode";
import { toHex, type InitSegmentDrmInfo, type TrackEncryptionInfo } from "./types";

// Minimal mp4box type — we only need createFile + appendBuffer + getTrackById
interface Mp4boxFile {
  appendBuffer(data: ArrayBuffer): void;
  flush(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTrackById(id: number): any;
  moov?: { traks?: { tkhd?: { track_id: number } }[] };
}
interface Mp4boxModule {
  createFile(): Mp4boxFile;
}

let mp4boxModule: Mp4boxModule | null = null;

async function getMp4box(): Promise<Mp4boxModule> {
  if (!mp4boxModule) {
    mp4boxModule = await import("mp4box");
  }
  return mp4boxModule;
}

/**
 * Parse an init segment to extract per-track encryption info and PSSH boxes.
 * Returns null if parsing fails.
 */
export async function parseInitSegmentDrm(
  initData: ArrayBuffer,
): Promise<InitSegmentDrmInfo | null> {
  try {
    const MP4Box = await getMp4box();
    const mp4 = MP4Box.createFile();

    // mp4box needs fileStart property on the buffer
    const buf = initData.slice(0) as ArrayBuffer & { fileStart: number };
    (buf as ArrayBuffer & { fileStart: number }).fileStart = 0;
    mp4.appendBuffer(buf);
    mp4.flush();

    // Find all track IDs from moov
    const trackIds: number[] = [];
    const traks = mp4.moov?.traks;
    if (traks) {
      for (const trak of traks) {
        if (trak.tkhd?.track_id) {
          trackIds.push(trak.tkhd.track_id);
        }
      }
    }

    // Extract encryption info per track
    const tracks: TrackEncryptionInfo[] = [];
    for (const trackId of trackIds) {
      const tencInfo = extractTenc(mp4, trackId);
      if (!tencInfo) continue; // track is not encrypted

      const scheme = extractScheme(mp4, trackId);
      tracks.push({
        trackId,
        scheme,
        defaultKid: toHex(tencInfo.defaultKID),
        defaultIvSize: tencInfo.defaultPerSampleIVSize,
        defaultConstantIv: tencInfo.defaultConstantIV
          ? toHex(tencInfo.defaultConstantIV)
          : null,
      });
    }

    // Find PSSH boxes in the raw init segment bytes
    const psshBoxes = findAllPsshBoxes(new Uint8Array(initData), "init-segment");

    // Only return if we found something meaningful
    if (tracks.length === 0 && psshBoxes.length === 0) return null;

    return { tracks, psshBoxes };
  } catch (e) {
    console.warn("[DRM Diagnostics] Failed to parse init segment:", e);
    return null;
  }
}

import { describe, it, expect } from "vitest";
import { parsePsshBox, findAllPsshBoxes, decodePsshBase64 } from "./psshDecode";
import type { WidevinePssh, PlayReadyPssh } from "./types";

/** Build a minimal PSSH box content (after the 8-byte box header). */
function buildPsshContent(opts: {
  version?: number;
  systemIdHex: string;
  kidHexes?: string[];
  dataHex?: string;
}): Uint8Array {
  const parts: number[] = [];

  // FullBox: version(1) + flags(3)
  parts.push(opts.version ?? 0, 0, 0, 0);

  // SystemID (16 bytes from hex)
  const sysId = hexToBytes(opts.systemIdHex);
  parts.push(...sysId);

  // KIDs (version 1 only)
  if ((opts.version ?? 0) >= 1 && opts.kidHexes) {
    // KID count (uint32 BE)
    const count = opts.kidHexes.length;
    parts.push((count >> 24) & 0xff, (count >> 16) & 0xff, (count >> 8) & 0xff, count & 0xff);
    for (const kidHex of opts.kidHexes) {
      parts.push(...hexToBytes(kidHex));
    }
  }

  // Data
  const data = opts.dataHex ? hexToBytes(opts.dataHex) : [];
  const dataLen = data.length;
  parts.push((dataLen >> 24) & 0xff, (dataLen >> 16) & 0xff, (dataLen >> 8) & 0xff, dataLen & 0xff);
  parts.push(...data);

  return new Uint8Array(parts);
}

/** Build a full PSSH box (with 8-byte header). */
function buildFullPsshBox(content: Uint8Array): Uint8Array {
  const totalSize = 8 + content.length;
  const box = new Uint8Array(totalSize);
  const view = new DataView(box.buffer);
  view.setUint32(0, totalSize);
  box[4] = 0x70; // 'p'
  box[5] = 0x73; // 's'
  box[6] = 0x73; // 's'
  box[7] = 0x68; // 'h'
  box.set(content, 8);
  return box;
}

/** Build an ISOBMFF-like structure wrapping PSSH in a moov container. */
function buildMoovWithPssh(psshBox: Uint8Array): Uint8Array {
  const moovSize = 8 + psshBox.length;
  const moov = new Uint8Array(moovSize);
  const view = new DataView(moov.buffer);
  view.setUint32(0, moovSize);
  moov[4] = 0x6d; // 'm'
  moov[5] = 0x6f; // 'o'
  moov[6] = 0x6f; // 'o'
  moov[7] = 0x76; // 'v'
  moov.set(psshBox, 8);
  return moov;
}

function hexToBytes(hex: string): number[] {
  const clean = hex.replaceAll("-", "").replaceAll(" ", "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

const WIDEVINE_SYS_ID = "edef8ba979d64acea3c827dcd51d21ed";
const PLAYREADY_SYS_ID = "9a04f07998404286ab92e65be0885f95";
const CLEARKEY_SYS_ID = "1077efecc0b24d02ace33c1e52e2fb4b";

describe("parsePsshBox", () => {
  it("parses a version 0 Widevine PSSH box", () => {
    // Widevine protobuf data: field 2 (key_id) = 16 bytes
    // tag=0x12 (field 2, wire type 2), length=0x10, then 16 bytes of KID
    const kidBytes = "0102030405060708090a0b0c0d0e0f10";
    const pbData = "12" + "10" + kidBytes; // field 2, length 16, KID

    const content = buildPsshContent({
      version: 0,
      systemIdHex: WIDEVINE_SYS_ID,
      dataHex: pbData,
    });

    const box = parsePsshBox(content, "manifest");
    expect(box).not.toBeNull();
    expect(box!.systemName).toBe("Widevine");
    expect(box!.systemId).toBe("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed");
    expect(box!.version).toBe(0);
    expect(box!.keyIds).toHaveLength(0); // version 0, no KIDs in box header

    // Decoded Widevine protobuf
    const wv = box!.decoded as WidevinePssh;
    expect(wv).toBeDefined();
    expect(wv.keyIds).toHaveLength(1);
    expect(wv.keyIds[0]).toBe("01020304-0506-0708-090a-0b0c0d0e0f10");
  });

  it("parses a version 1 PSSH box with KIDs in header", () => {
    const kid = "a1b2c3d4e5f60718293041526374a5b6";
    const content = buildPsshContent({
      version: 1,
      systemIdHex: CLEARKEY_SYS_ID,
      kidHexes: [kid],
      dataHex: "",
    });

    const box = parsePsshBox(content, "init-segment");
    expect(box).not.toBeNull();
    expect(box!.systemName).toBe("ClearKey (W3C)");
    expect(box!.version).toBe(1);
    expect(box!.keyIds).toHaveLength(1);
    expect(box!.keyIds[0]).toBe("a1b2c3d4-e5f6-0718-2930-41526374a5b6");
    expect(box!.source).toBe("init-segment");
  });

  it("parses a PlayReady PSSH box", () => {
    // Build a minimal PlayReady Object Header with Record Type 1
    // UTF-16LE XML: <WRMHEADER><KID>AAAAAAAAAAAAAAAAAAAAAA==</KID></WRMHEADER>
    const xml = '<WRMHEADER><KID>AAAAAAAAAAAAAAAAAAAAAA==</KID></WRMHEADER>';
    const xmlBytes: number[] = [];
    for (const ch of xml) {
      xmlBytes.push(ch.charCodeAt(0), 0); // UTF-16LE
    }

    // Record: type(2 LE) + length(2 LE) + data
    const recordType = [1, 0]; // type 1 = Rights Management Header
    const recordLen = [xmlBytes.length & 0xff, (xmlBytes.length >> 8) & 0xff];

    // PlayReady Object Header: totalLength(4 LE) + recordCount(2 LE) + records
    const headerLen = 6 + 4 + xmlBytes.length;
    const header: number[] = [
      headerLen & 0xff, (headerLen >> 8) & 0xff, (headerLen >> 16) & 0xff, (headerLen >> 24) & 0xff,
      1, 0, // 1 record
      ...recordType, ...recordLen,
      ...xmlBytes,
    ];

    const dataHex = header.map(b => b.toString(16).padStart(2, "0")).join("");
    const content = buildPsshContent({
      version: 0,
      systemIdHex: PLAYREADY_SYS_ID,
      dataHex,
    });

    const box = parsePsshBox(content, "manifest");
    expect(box).not.toBeNull();
    expect(box!.systemName).toBe("PlayReady");

    const pr = box!.decoded as PlayReadyPssh;
    expect(pr).toBeDefined();
    expect(pr.kid).toBeDefined();
  });

  it("returns null for too-short data", () => {
    const box = parsePsshBox(new Uint8Array(10), "manifest");
    expect(box).toBeNull();
  });

  it("handles unknown system IDs gracefully", () => {
    const content = buildPsshContent({
      version: 0,
      systemIdHex: "00000000000000000000000000000000",
      dataHex: "deadbeef",
    });

    const box = parsePsshBox(content, "manifest");
    expect(box).not.toBeNull();
    expect(box!.systemName).toBe("Unknown");
    expect(box!.decoded).toBeUndefined();
    expect(box!.data.length).toBe(4);
  });
});

describe("findAllPsshBoxes", () => {
  it("finds PSSH boxes at the top level", () => {
    const psshContent = buildPsshContent({
      version: 0,
      systemIdHex: WIDEVINE_SYS_ID,
      dataHex: "",
    });
    const psshBox = buildFullPsshBox(psshContent);
    const boxes = findAllPsshBoxes(psshBox, "init-segment");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].systemName).toBe("Widevine");
  });

  it("finds PSSH boxes inside moov container", () => {
    const psshContent = buildPsshContent({
      version: 0,
      systemIdHex: CLEARKEY_SYS_ID,
      dataHex: "",
    });
    const psshBox = buildFullPsshBox(psshContent);
    const moov = buildMoovWithPssh(psshBox);
    const boxes = findAllPsshBoxes(moov, "init-segment");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].systemName).toBe("ClearKey (W3C)");
  });

  it("finds multiple PSSH boxes", () => {
    const wv = buildFullPsshBox(buildPsshContent({ version: 0, systemIdHex: WIDEVINE_SYS_ID, dataHex: "" }));
    const pr = buildFullPsshBox(buildPsshContent({ version: 0, systemIdHex: PLAYREADY_SYS_ID, dataHex: "" }));
    const combined = new Uint8Array(wv.length + pr.length);
    combined.set(wv, 0);
    combined.set(pr, wv.length);
    const boxes = findAllPsshBoxes(combined, "manifest");
    expect(boxes).toHaveLength(2);
    expect(boxes.map(b => b.systemName)).toContain("Widevine");
    expect(boxes.map(b => b.systemName)).toContain("PlayReady");
  });

  it("returns empty array for non-PSSH data", () => {
    const randomBox = new Uint8Array(16);
    new DataView(randomBox.buffer).setUint32(0, 16);
    randomBox[4] = 0x66; randomBox[5] = 0x74; randomBox[6] = 0x79; randomBox[7] = 0x70; // ftyp
    const boxes = findAllPsshBoxes(randomBox, "init-segment");
    expect(boxes).toHaveLength(0);
  });
});

describe("decodePsshBase64", () => {
  it("decodes a base64-encoded PSSH box", () => {
    const psshContent = buildPsshContent({
      version: 0,
      systemIdHex: WIDEVINE_SYS_ID,
      dataHex: "",
    });
    const fullBox = buildFullPsshBox(psshContent);
    const b64 = btoa(String.fromCharCode(...fullBox));

    const box = decodePsshBase64(b64, "manifest");
    expect(box).not.toBeNull();
    expect(box!.systemName).toBe("Widevine");
    expect(box!.source).toBe("manifest");
  });

  it("returns null for invalid base64", () => {
    const box = decodePsshBase64("not-valid-base64!!!", "manifest");
    expect(box).toBeNull();
  });

  it("returns null for too-short base64", () => {
    const box = decodePsshBase64(btoa("hi"), "manifest");
    expect(box).toBeNull();
  });
});

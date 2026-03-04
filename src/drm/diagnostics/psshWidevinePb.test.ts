import { describe, it, expect } from "vitest";
import { decodeWidevinePssh } from "./psshWidevinePb";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replaceAll(" ", "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

describe("decodeWidevinePssh", () => {
  it("decodes algorithm field (field 1, varint)", () => {
    // field 1, wire type 0 (varint): tag = 0x08, value = 1 (AESCTR)
    const data = hexToBytes("0801");
    const result = decodeWidevinePssh(data);
    expect(result.algorithm).toBe("AESCTR");
  });

  it("decodes key_id field (field 2, length-delimited, 16 bytes → UUID)", () => {
    // field 2, wire type 2: tag = 0x12, length = 0x10
    const kid = "0102030405060708090a0b0c0d0e0f10";
    const data = hexToBytes("1210" + kid);
    const result = decodeWidevinePssh(data);
    expect(result.keyIds).toHaveLength(1);
    expect(result.keyIds[0]).toBe("01020304-0506-0708-090a-0b0c0d0e0f10");
  });

  it("decodes multiple key_ids", () => {
    const kid1 = "0102030405060708090a0b0c0d0e0f10";
    const kid2 = "a1b2c3d4e5f60718293041526374a5b6";
    const data = hexToBytes("1210" + kid1 + "1210" + kid2);
    const result = decodeWidevinePssh(data);
    expect(result.keyIds).toHaveLength(2);
  });

  it("decodes provider field (field 3, string)", () => {
    // field 3, wire type 2: tag = 0x1a
    const providerBytes = new TextEncoder().encode("test_provider");
    const lenHex = providerBytes.length.toString(16).padStart(2, "0");
    const providerHex = Array.from(providerBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    const data = hexToBytes("1a" + lenHex + providerHex);
    const result = decodeWidevinePssh(data);
    expect(result.provider).toBe("test_provider");
  });

  it("decodes content_id field (field 4, bytes)", () => {
    // field 4, wire type 2: tag = 0x22
    const contentId = "68656c6c6f"; // "hello" in hex
    const data = hexToBytes("22" + "05" + contentId);
    const result = decodeWidevinePssh(data);
    expect(result.contentId).toBe("68656c6c6f");
    expect(result.contentIdUtf8).toBe("hello");
  });

  it("decodes policy field (field 6, string)", () => {
    // field 6, wire type 2: tag = 0x32
    const policyBytes = new TextEncoder().encode("default");
    const lenHex = policyBytes.length.toString(16).padStart(2, "0");
    const policyHex = Array.from(policyBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    const data = hexToBytes("32" + lenHex + policyHex);
    const result = decodeWidevinePssh(data);
    expect(result.policy).toBe("default");
  });

  it("decodes protection_scheme field (field 9, fixed32)", () => {
    // field 9, wire type 5 (fixed32): tag = 0x4d
    // "cenc" = 0x63656e63
    const data = hexToBytes("4d63656e63");
    const result = decodeWidevinePssh(data);
    expect(result.protectionScheme).toBe("cenc");
  });

  it("decodes combined fields", () => {
    const kid = "0102030405060708090a0b0c0d0e0f10";
    const data = hexToBytes(
      "0801" +              // algorithm = AESCTR
      "1210" + kid +        // key_id
      "1a04" + "74657374" + // provider = "test"
      "4d63656e63"          // protection_scheme = cenc
    );
    const result = decodeWidevinePssh(data);
    expect(result.algorithm).toBe("AESCTR");
    expect(result.keyIds).toHaveLength(1);
    expect(result.provider).toBe("test");
    expect(result.protectionScheme).toBe("cenc");
  });

  it("decodes key_id stored as 32-char hex ASCII string", () => {
    // Some packagers store KID as ASCII hex string (32 bytes) instead of raw 16 bytes
    const kidHex = "7f0195f478943a898a2b5b38fc9a4e49";
    const kidBytes = new TextEncoder().encode(kidHex);
    const lenHex = kidBytes.length.toString(16).padStart(2, "0");
    const dataHex = Array.from(kidBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    const data = hexToBytes("12" + lenHex + dataHex);
    const result = decodeWidevinePssh(data);
    expect(result.keyIds).toHaveLength(1);
    expect(result.keyIds[0]).toBe("7f0195f4-7894-3a89-8a2b-5b38fc9a4e49");
  });

  it("handles empty data", () => {
    const result = decodeWidevinePssh(new Uint8Array(0));
    expect(result.keyIds).toHaveLength(0);
    expect(result.algorithm).toBeUndefined();
  });

  it("skips unknown fields gracefully", () => {
    // field 99, wire type 0 (varint): tag = (99 << 3 | 0) = 0x318 → varint 0x98 0x06
    // followed by value 42
    const data = hexToBytes("9806" + "2a" + "0801");
    const result = decodeWidevinePssh(data);
    expect(result.algorithm).toBe("AESCTR");
  });
});

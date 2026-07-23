import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, stringToBase64 } from "./base64";

describe("base64", () => {
  it("roundtrips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 27, 91, 72]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("roundtrips empty input", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array(0));
  });

  it("encodes multibyte UTF-8 strings", () => {
    const b64 = stringToBase64("héllo 你好 🚀");
    const decoded = new TextDecoder().decode(base64ToBytes(b64));
    expect(decoded).toBe("héllo 你好 🚀");
  });

  it("handles payloads larger than one chunk without overflowing", () => {
    const big = new Uint8Array(256 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });

  it("throws on invalid base64 input", () => {
    expect(() => base64ToBytes("!!!not-base64!!!")).toThrow();
  });
});

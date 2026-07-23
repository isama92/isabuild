// Base64 helpers for PTY payloads. Encoding walks the byte array in fixed
// chunks: spreading a whole buffer into String.fromCharCode overflows the
// call stack on large PTY output bursts.

const CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** Throws a DOMException on input that is not valid base64. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** UTF-8 encode a string (e.g. xterm onData input), then base64 it. */
export function stringToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

/**
 * Loro speaks Uint8Array; PostgREST speaks JSON. Base64 is the bridge.
 *
 * Chunked so a large snapshot can't blow the argument limit of
 * String.fromCharCode via a spread of a multi-megabyte array.
 */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...(bytes.subarray(i, i + CHUNK) as unknown as number[]),
    );
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The URL-safe alphabet, for a key that rides in a link's fragment. Standard
 * base64's `+` and `/` survive a fragment technically, but not a paste into
 * every chat client that decides where a URL ends — and `=` padding is pure
 * bait for a trailing-punctuation trimmer.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replaceAll("-", "+").replaceAll("_", "/");
  return base64ToBytes(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
}

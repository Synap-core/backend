/**
 * Image sniffing for the media-copy job — the bytes decide, never the server's
 * `Content-Type`.
 *
 * Pure TS, no native dependency. Recognises exactly the raster types the
 * display door may draw inline (`INLINE_IMAGE_MIME_TYPES`,
 * `@synap-core/types/presentation`: png · jpeg · gif · webp) — the type is
 * DERIVED from that list, so the sniffer cannot return a type it does not
 * hold. Everything else — SVG, HTML, a video, a lying `image/png` that is
 * really markup — sniffs to `null` and is refused.
 */

import { INLINE_IMAGE_MIME_TYPES } from "@synap-core/types/presentation";

export type CopiedImageMime = (typeof INLINE_IMAGE_MIME_TYPES)[number];

/** The `Accept` header of an image copy: exactly the inline list. */
export const COPIED_IMAGE_ACCEPT = `${INLINE_IMAGE_MIME_TYPES.join(",")};q=0.9`;

/** Bytes needed to decide the type (the WebP RIFF header is the longest). */
export const SNIFF_HEAD_BYTES = 12;

/** The image type the leading bytes prove, or null. */
export function sniffImageType(head: Uint8Array): CopiedImageMime | null {
  const b = head;
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (
    b.length >= 6 &&
    ascii(b, 0, 4) === "GIF8" &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  )
    return "image/gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP")
    return "image/webp";
  return null;
}

/** Pixel size read from the header; absent when the header does not carry it. */
export function sniffImageSize(
  bytes: Uint8Array,
  mime: CopiedImageMime
): { width: number; height: number } | null {
  switch (mime) {
    case "image/png":
      // IHDR is the first chunk: width/height big-endian at 16 and 20.
      if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
      return sized(be32(bytes, 16), be32(bytes, 20));
    case "image/gif":
      if (bytes.length < 10) return null;
      return sized(le16(bytes, 6), le16(bytes, 8));
    case "image/webp":
      return webpSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
  }
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // Lossy: frame tag (3) + start code 9d 01 2a, then 14-bit width/height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sized(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    // Lossless: signature 0x2f, then 14-bit (width-1) and (height-1).
    if (b[20] !== 0x2f) return null;
    const b1 = b[21]!;
    const b2 = b[22]!;
    const b3 = b[23]!;
    const b4 = b[24]!;
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return sized(width, height);
  }
  if (chunk === "VP8X") {
    // Extended: 24-bit (canvas width-1) at 24, (height-1) at 27.
    return sized(1 + le24(b, 24), 1 + le24(b, 27));
  }
  return null;
}

/** Walk the JPEG segments to the first start-of-frame marker. */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) return sized(be16(b, i + 7), be16(b, i + 5));
    const len = be16(b, i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function sized(
  width: number,
  height: number
): { width: number; height: number } | null {
  return width > 0 && height > 0 ? { width, height } : null;
}
function ascii(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let k = 0; k < n; k++) s += String.fromCharCode(b[at + k] ?? 0);
  return s;
}
function be16(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}
function be32(b: Uint8Array, at: number): number {
  return (
    (((b[at] ?? 0) << 24) >>> 0) +
    ((b[at + 1] ?? 0) << 16) +
    ((b[at + 2] ?? 0) << 8) +
    (b[at + 3] ?? 0)
  );
}
function le16(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}
function le24(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
}

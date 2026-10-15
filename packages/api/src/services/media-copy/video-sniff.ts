/**
 * Video sniffing for the media copy — the bytes decide, never `Content-Type`.
 *
 * Recognises exactly the two containers the display door may play inline
 * (`INLINE_VIDEO_MIME_TYPES`, `@synap-core/types/presentation`): MP4 and
 * WebM. Everything else — HTML, SVG, a QuickTime `.mov`, a Matroska `.mkv`, a
 * HEIF photo (also an ISO-BMFF `ftyp` box) — sniffs to `null` and is refused.
 *
 *   • MP4  → an ISO-BMFF `ftyp` box first (bytes 4..8 = "ftyp") whose MAJOR
 *            brand is an MP4 video brand (isom, iso2…, mp41, mp42, avc1, dash,
 *            M4V…). `qt  ` (QuickTime) and `heic`/`mif1` (images) are not.
 *   • WebM → the EBML magic `1A 45 DF A3` and a DocType of "webm" in the
 *            header (Matroska shares the magic; only its DocType tells).
 */

import type { INLINE_VIDEO_MIME_TYPES } from "@synap-core/types/presentation";

export type CopiedVideoMime = (typeof INLINE_VIDEO_MIME_TYPES)[number];

/** Bytes read before deciding (the EBML header with its DocType fits). */
export const VIDEO_SNIFF_HEAD_BYTES = 64;

const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso7",
  "iso8",
  "iso9",
  "mp41",
  "mp42",
  "mp71",
  "avc1",
  "dash",
  "M4V ",
  "M4VH",
  "M4VP",
  "MSNV",
  "mmp4",
  "f4v ",
]);

/** EBML DocType element id (0x4282) followed by a 1-byte size `0x84` + "webm". */
const WEBM_DOCTYPE = [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d];

export function sniffVideoType(head: Uint8Array): CopiedVideoMime | null {
  const b = head;
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    return MP4_BRANDS.has(ascii(b, 8, 4)) ? "video/mp4" : null;
  }
  if (
    b.length >= 4 &&
    b[0] === 0x1a &&
    b[1] === 0x45 &&
    b[2] === 0xdf &&
    b[3] === 0xa3
  ) {
    return indexOf(b, WEBM_DOCTYPE) >= 0 ? "video/webm" : null;
  }
  return null;
}

function indexOf(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let k = 0; k < n; k++) s += String.fromCharCode(b[at + k] ?? 0);
  return s;
}

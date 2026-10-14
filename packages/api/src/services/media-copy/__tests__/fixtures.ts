/** Minimal real headers for each allowed image type (enough to sniff + size). */

export function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([...ascii("IHDR")], 12);
  be32(b, 16, width);
  be32(b, 20, height);
  return b;
}

export function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment (to prove the walker skips segments), then SOF0.
  const app0 = [
    0xff,
    0xe0,
    0x00,
    0x10,
    ...ascii("JFIF"),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ];
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

export function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([
    ...ascii("GIF89a"),
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
    0,
    0,
    0,
  ]);
}

export function webpLossy(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([...ascii("RIFF")], 0);
  b.set([...ascii("WEBP")], 8);
  b.set([...ascii("VP8 ")], 12);
  b.set([0x9d, 0x01, 0x2a], 23);
  b[26] = width & 0xff;
  b[27] = (width >> 8) & 0x3f;
  b[28] = height & 0xff;
  b[29] = (height >> 8) & 0x3f;
  return b;
}

export function webpLossless(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([...ascii("RIFF")], 0);
  b.set([...ascii("WEBP")], 8);
  b.set([...ascii("VP8L")], 12);
  b[20] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  b[21] = w & 0xff;
  b[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  b[23] = (h >> 2) & 0xff;
  b[24] = (h >> 10) & 0x0f;
  return b;
}

export function webpExtended(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([...ascii("RIFF")], 0);
  b.set([...ascii("WEBP")], 8);
  b.set([...ascii("VP8X")], 12);
  le24(b, 24, width - 1);
  le24(b, 27, height - 1);
  return b;
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}
function be32(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}
function le24(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff;
  b[at + 1] = (v >> 8) & 0xff;
  b[at + 2] = (v >> 16) & 0xff;
}

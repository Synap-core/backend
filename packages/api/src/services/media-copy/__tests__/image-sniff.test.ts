import { describe, expect, it } from "vitest";
import { sniffImageSize, sniffImageType } from "../image-sniff.js";
import {
  gif,
  jpeg,
  png,
  webpExtended,
  webpLossless,
  webpLossy,
} from "./fixtures.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("sniffImageType + sniffImageSize", () => {
  it.each([
    ["png", png(640, 480), "image/png", { width: 640, height: 480 }],
    ["jpeg", jpeg(1200, 675), "image/jpeg", { width: 1200, height: 675 }],
    ["gif", gif(320, 200), "image/gif", { width: 320, height: 200 }],
    [
      "webp VP8",
      webpLossy(800, 600),
      "image/webp",
      { width: 800, height: 600 },
    ],
    [
      "webp VP8L",
      webpLossless(1080, 1350),
      "image/webp",
      { width: 1080, height: 1350 },
    ],
    [
      "webp VP8X",
      webpExtended(4000, 3000),
      "image/webp",
      { width: 4000, height: 3000 },
    ],
  ] as const)(
    "%s: type from magic bytes, size from the header",
    (_n, bytes, mime, size) => {
      expect(sniffImageType(bytes)).toBe(mime);
      expect(sniffImageSize(bytes, mime)).toEqual(size);
    }
  );

  it.each([
    [
      "SVG",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ],
    ["SVG with XML prolog", '<?xml version="1.0"?><svg/>'],
    ["HTML", "<!doctype html><html><body>hi</body></html>"],
    ["a RIFF that is not WebP (AVI)", "RIFF\u0000\u0000\u0000\u0000AVI LIST"],
    ["MP4", "\u0000\u0000\u0000\u0018ftypmp42"],
  ])("refuses %s", (_n, body) => {
    expect(sniffImageType(enc(body))).toBeNull();
  });

  it("a truncated header sniffs a type but no size (never a made-up size)", () => {
    expect(sniffImageSize(png(10, 10).subarray(0, 12), "image/png")).toBeNull();
    expect(
      sniffImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")
    ).toBeNull();
  });
});

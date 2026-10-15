import { describe, expect, it } from "vitest";
import { readLibraryItemMedia, readLibraryItemRead } from "./library.js";

const STAMP = {
  id: "builtin:article",
  name: "Article",
  billed: false,
  readAt: "2026-10-15T00:00:00.000Z",
};

describe("readLibraryItemRead — the reader stamp arrives", () => {
  it("passes a stored reader stamp through", () => {
    const read = readLibraryItemRead({
      importRead: {
        status: "read",
        suggestedActions: [],
        reader: { ...STAMP, verbId: "capture_social_post", junk: 1 },
      },
    });
    expect(read.reader).toEqual({ ...STAMP, verbId: "capture_social_post" });
  });

  it("drops a malformed stamp, keeps the read", () => {
    const read = readLibraryItemRead({
      importRead: { status: "read", suggestedActions: [], reader: { id: "x" } },
    });
    expect(read.status).toBe("read");
    expect(read.reader).toBeUndefined();
  });
});

describe("readLibraryItemMedia", () => {
  const copy = (order: number, kind = "image") => ({
    documentId: `d${order}`,
    mime: kind === "video" ? "video/mp4" : "image/jpeg",
    bytes: 10,
    sourceUrl: `https://cdn.test/${order}`,
    copiedAt: "2026-10-15T00:00:00.000Z",
    kind,
    order,
  });

  it("reads the copies in order and the failed count", () => {
    const r = readLibraryItemMedia({
      importMedia: [
        copy(2, "video"),
        copy(0),
        { documentId: 3 },
        copy(1, "audio"),
      ],
      importMediaFailed: 2,
    });
    expect(r.media.map((m) => m.documentId)).toEqual(["d0", "d2"]);
    expect(r.failed).toBe(2);
  });

  it("absent → empty, zero (never throws)", () => {
    expect(readLibraryItemMedia(null)).toEqual({ media: [], failed: 0 });
    expect(
      readLibraryItemMedia({ importMedia: "x", importMediaFailed: -1 })
    ).toEqual({
      media: [],
      failed: 0,
    });
  });
});

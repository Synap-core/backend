import { describe, expect, it } from "vitest";
import { parseProfilePresentation, readEntityMediaCopies } from "./index.js";

describe("parseProfilePresentation", () => {
  it("accepts a full declaration and drops unknown keys", () => {
    const r = parseProfilePresentation({
      family: "media",
      media: { source: { property: "asset-document-id" }, kind: "image" },
      fields: { card: ["asset-kind"], row: ["asset-status"] },
      junk: 1,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        family: "media",
        media: { source: { property: "asset-document-id" }, kind: "image" },
        fields: { card: ["asset-kind"], row: ["asset-status"] },
      },
    });
  });

  it("defaults media kind to auto", () => {
    const r = parseProfilePresentation({ family: "media", media: { source: { documentId: true } } });
    expect(r.ok && r.value.media?.kind).toBe("auto");
  });

  it("rejects an unknown family, two sources and over-cap fields", () => {
    const r = parseProfilePresentation({
      family: "gallery",
      media: { source: { property: "a", entityRef: "b" } },
      fields: { row: ["a", "b", "c"] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.path)).toEqual([
        "presentation.family",
        "presentation.media.source",
        "presentation.fields.row",
      ]);
    }
  });

  it("rejects documentId other than true", () => {
    const r = parseProfilePresentation({ family: "document", media: { source: { documentId: "x" } } });
    expect(r.ok).toBe(false);
  });
});

describe("readEntityMediaCopies", () => {
  it("keeps only well-formed copies", () => {
    expect(
      readEntityMediaCopies({
        media: [
          { documentId: "d1", mime: "image/png", sourceUrl: "https://x/a.png", bytes: 1, copiedAt: "t" },
          { documentId: "", mime: "image/png", sourceUrl: "https://x" },
          "nope",
        ],
      }).map((m) => m.documentId),
    ).toEqual(["d1"]);
    expect(readEntityMediaCopies(null)).toEqual([]);
  });
});

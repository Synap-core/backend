import { describe, expect, it } from "vitest";
import {
  declaredMediaSources,
  parseProfilePresentation,
  presentationFromUiHints,
  readEntityMediaCopies,
} from "./index.js";

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

  it("keeps ordered fallbacks; declaredMediaSources lists source then fallbacks", () => {
    const r = parseProfilePresentation({
      family: "media",
      media: {
        source: { property: "asset-document-id" },
        fallbacks: [{ entityRef: "cover" }, { property: "asset-url" }],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.media?.fallbacks).toEqual([{ entityRef: "cover" }, { property: "asset-url" }]);
    expect(declaredMediaSources(r.value)).toEqual([
      { property: "asset-document-id" },
      { entityRef: "cover" },
      { property: "asset-url" },
    ]);
    expect(declaredMediaSources(null)).toEqual([]);
    expect(declaredMediaSources({ family: "record" })).toEqual([]);
  });

  it("rejects a malformed, repeated, empty or over-long fallback list", () => {
    const paths = (fallbacks: unknown) => {
      const r = parseProfilePresentation({
        family: "media",
        media: { source: { property: "a" }, fallbacks },
      });
      return r.ok ? [] : r.issues.map((i) => i.path);
    };
    expect(paths([{ property: "a" }])).toEqual(["presentation.media.fallbacks.0"]);
    expect(paths([{ property: "b" }, { property: "b" }])).toEqual(["presentation.media.fallbacks.1"]);
    expect(paths([{ property: "b", entityRef: "c" }])).toEqual(["presentation.media.fallbacks.0"]);
    expect(paths(["b"])).toEqual(["presentation.media.fallbacks.0"]);
    expect(paths([])).toEqual(["presentation.media.fallbacks"]);
    expect(paths({ property: "b" })).toEqual(["presentation.media.fallbacks"]);
    expect(
      paths([{ property: "b" }, { property: "c" }, { property: "d" }, { property: "e" }]),
    ).toEqual(["presentation.media.fallbacks"]);
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

describe("presentationFromUiHints", () => {
  it("reads a valid declaration off uiHints", () => {
    expect(
      presentationFromUiHints({ icon: "x", presentation: { family: "media" } })
    ).toMatchObject({ family: "media" });
  });
  it("null when absent, invalid, or uiHints is not an object", () => {
    expect(presentationFromUiHints({ icon: "x" })).toBeNull();
    expect(presentationFromUiHints({ presentation: { family: "nope" } })).toBeNull();
    expect(presentationFromUiHints(null)).toBeNull();
    expect(presentationFromUiHints([])).toBeNull();
    expect(presentationFromUiHints("media")).toBeNull();
  });
});

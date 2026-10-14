import { describe, expect, it } from "vitest";
import {
  resolveEntityMedia,
  resolvePresentationFamily,
  type EntityMediaCopy,
  type ProfilePresentation,
} from "./index.js";

const DOC = "11111111-1111-4111-8111-111111111111";
const DOC2 = "22222222-2222-4222-8222-222222222222";
const ENT = "33333333-3333-4333-8333-333333333333";
const URL_A = "https://example.org/a.jpg";
const URL_B = "https://example.org/b.jpg";

const copy = (
  documentId: string,
  sourceUrl: string,
  extra: Partial<EntityMediaCopy> = {}
): EntityMediaCopy => ({
  documentId,
  mime: "image/jpeg",
  bytes: 10,
  sourceUrl,
  copiedAt: "2026-10-13T00:00:00.000Z",
  ...extra,
});

const byProperty = (
  property: string,
  kind?: "image" | "video" | "auto"
): ProfilePresentation => ({
  family: "link",
  media: { source: { property }, ...(kind ? { kind } : {}) },
});

describe("resolveEntityMedia", () => {
  it("(a) the copy whose sourceUrl equals the declared URL wins over an earlier copy", () => {
    const r = resolveEntityMedia(
      {
        id: "e",
        properties: { image: URL_B },
        systemData: {
          media: [
            copy(DOC, URL_A),
            copy(DOC2, URL_B, { width: 640, height: 480 }),
          ],
        },
      },
      byProperty("image")
    );
    expect(r.primary).toEqual({
      via: "stored",
      documentId: DOC2,
      mime: "image/jpeg",
      width: 640,
      height: 480,
    });
    expect(r.all).toEqual([
      r.primary,
      { via: "stored", documentId: DOC, mime: "image/jpeg" },
    ]);
  });

  it("(a) no copy matches the declared URL: the first copy (a derived image of it) wins, never the hot link", () => {
    const r = resolveEntityMedia(
      {
        id: "e",
        properties: { url: "https://example.org/page" },
        systemData: { media: [copy(DOC, URL_A)] },
      },
      byProperty("url")
    );
    expect(r.primary).toEqual({
      via: "stored",
      documentId: DOC,
      mime: "image/jpeg",
    });
  });

  it("(b) declared property holding an http(s) URL, no copy → external with the declared kind", () => {
    const r = resolveEntityMedia(
      { id: "e", properties: { url: URL_A } },
      byProperty("url", "video")
    );
    expect(r.primary).toEqual({ via: "external", url: URL_A, kind: "video" });
    expect(r.all).toEqual([r.primary]);
  });

  it("(b) external kind defaults to auto", () => {
    expect(
      resolveEntityMedia(
        { id: "e", properties: { url: URL_A } },
        byProperty("url")
      ).primary
    ).toEqual({
      via: "external",
      url: URL_A,
      kind: "auto",
    });
  });

  it("(b) declared property holding a document id → stored, mime passed through (even svg)", () => {
    const r = resolveEntityMedia(
      {
        id: "e",
        properties: { "asset-document-id": DOC, mimeType: "image/svg+xml" },
      },
      { family: "media", media: { source: { property: "asset-document-id" } } }
    );
    expect(r.primary).toEqual({
      via: "stored",
      documentId: DOC,
      mime: "image/svg+xml",
    });
  });

  it("(b) a list value reads its first string", () => {
    const r = resolveEntityMedia(
      { id: "e", properties: { pics: [URL_A, URL_B] } },
      byProperty("pics")
    );
    expect(r.primary).toEqual({ via: "external", url: URL_A, kind: "auto" });
  });

  it("(b) {documentId: true} → the entity's own document, any mime", () => {
    const r = resolveEntityMedia(
      { id: "e", documentId: DOC, properties: { mimeType: "application/pdf" } },
      { family: "document", media: { source: { documentId: true } } }
    );
    expect(r.primary).toEqual({
      via: "stored",
      documentId: DOC,
      mime: "application/pdf",
    });
  });

  it("(b) {entityRef} → the referenced entity", () => {
    const r = resolveEntityMedia(
      { id: "e", properties: { cover: ENT } },
      { family: "work", media: { source: { entityRef: "cover" } } }
    );
    expect(r.primary).toEqual({ via: "stored", entityId: ENT });
  });

  it("(b) a declared value that is neither a URL nor an id yields nothing (falls through to none)", () => {
    expect(
      resolveEntityMedia(
        { id: "e", properties: { url: "not a link" } },
        byProperty("url")
      ).primary
    ).toEqual({
      via: "none",
    });
    expect(
      resolveEntityMedia(
        { id: "e", properties: { cover: "x" } },
        { family: "work", media: { source: { entityRef: "cover" } } }
      ).primary
    ).toEqual({ via: "none" });
  });

  it("(c) no declaration: the linked document when its mime is an image or a video", () => {
    expect(
      resolveEntityMedia({
        id: "e",
        documentId: DOC,
        properties: { mimeType: "video/mp4" },
      }).primary
    ).toEqual({
      via: "stored",
      documentId: DOC,
      mime: "video/mp4",
    });
  });

  it("(c) no declaration: a pdf document is NOT media", () => {
    expect(
      resolveEntityMedia({
        id: "e",
        documentId: DOC,
        properties: { mimeType: "application/pdf" },
      }).primary
    ).toEqual({
      via: "none",
    });
  });

  it("(c) a declared source that misses falls through to the linked image", () => {
    const r = resolveEntityMedia(
      { id: "e", documentId: DOC, properties: { mimeType: "image/png" } },
      byProperty("missing")
    );
    expect(r.primary).toEqual({
      via: "stored",
      documentId: DOC,
      mime: "image/png",
    });
  });

  it("(d) no media declaration (post = work): a pod-held copy is the primary, listed once", () => {
    const r = resolveEntityMedia(
      {
        id: "e",
        properties: { url: URL_A },
        systemData: { media: [copy(DOC, URL_A)] },
      },
      { family: "work" }
    );
    expect(r.primary).toEqual({ via: "stored", documentId: DOC, mime: "image/jpeg" });
    expect(r.all).toEqual([r.primary]);
  });

  it("(e) nothing at all → none", () => {
    const r = resolveEntityMedia({ id: "e", properties: { url: URL_A } });
    expect(r.primary).toEqual({ via: "none" });
    expect(r.all).toEqual([]);
  });

  it("never returns a URL for a stored ref and never decides renderability", () => {
    const r = resolveEntityMedia(
      { id: "e", properties: { p: DOC, mimeType: "text/html" } },
      byProperty("p")
    );
    expect(r.primary).toEqual({
      via: "stored",
      documentId: DOC,
      mime: "text/html",
    });
  });
});

describe("resolvePresentationFamily", () => {
  it("the declaration wins over the mime", () => {
    expect(resolvePresentationFamily({ family: "record" }, "image/png")).toBe(
      "record"
    );
  });
  it.each([
    ["image/png", "media"],
    ["video/mp4", "media"],
    ["application/pdf", "document"],
    ["text/plain", "document"],
    ["text/markdown", "document"],
    ["application/zip", undefined],
    [undefined, undefined],
  ] as const)("mime %s → %s", (mime, family) => {
    expect(resolvePresentationFamily(undefined, mime)).toBe(family);
  });
});

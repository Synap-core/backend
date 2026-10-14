import { describe, expect, it } from "vitest";
import {
  presentationFromUiHints,
  type EntityMediaCopy,
} from "@synap-core/types/presentation";
import {
  CAPTURED_MEDIA_URLS_PROPERTY,
  collectMediaSourceUrls,
  declaredMediaProperties,
  mergeMediaSystemData,
  planMediaCopy,
} from "../media-plan.js";
import { foldCapturedImage } from "../capture-media.js";

const declared = presentationFromUiHints({
  presentation: { family: "record", media: { source: { property: "image" } } },
});
/** The real link shape (catalog bookmark/article): the declared property IS the page. */
const linkDeclared = presentationFromUiHints({
  presentation: { family: "link", media: { source: { property: "url" } } },
});

const copy = (
  sourceUrl: string,
  documentId = "doc-" + sourceUrl.length
): EntityMediaCopy => ({
  documentId,
  mime: "image/png",
  bytes: 10,
  sourceUrl,
  copiedAt: "2026-10-13T00:00:00.000Z",
});

describe("presentationFromUiHints", () => {
  it("reads a valid declaration, null for none or invalid", () => {
    expect(declared?.media?.source).toEqual({ property: "image" });
    expect(presentationFromUiHints({})).toBeNull();
    expect(presentationFromUiHints(null)).toBeNull();
    expect(
      presentationFromUiHints({ presentation: { family: "nope" } })
    ).toBeNull();
  });
});

describe("collectMediaSourceUrls", () => {
  it("declared property first, then capture-provided media-urls; http(s) only, deduped", () => {
    expect(
      collectMediaSourceUrls(
        {
          image: "https://a.test/1.png",
          [CAPTURED_MEDIA_URLS_PROPERTY]: [
            "https://a.test/1.png",
            "https://a.test/2.jpg",
            "javascript:alert(1)",
            4,
          ],
        },
        declared
      )
    ).toEqual(["https://a.test/1.png", "https://a.test/2.jpg"]);
  });

  it("no presentation: the declared path contributes nothing", () => {
    expect(
      collectMediaSourceUrls({ image: "https://a.test/1.png" }, null)
    ).toEqual([]);
  });

  it("a stored-file reference in the declared property is not fetched", () => {
    expect(
      collectMediaSourceUrls(
        { image: "0b9f6c1e-1d2a-4c55-8a4e-9f0e5c3b2a10" },
        declared
      )
    ).toEqual([]);
  });
});

describe("link family: the declared property is the page, never fetched", () => {
  it("collects only media-urls for a link kind", () => {
    expect(
      collectMediaSourceUrls(
        {
          url: "https://blog.test/post",
          [CAPTURED_MEDIA_URLS_PROPERTY]: ["https://blog.test/og.jpg"],
        },
        linkDeclared
      )
    ).toEqual(["https://blog.test/og.jpg"]);
  });

  it("the capture fold never writes the og:image into a link's url", () => {
    const [one] = foldCapturedImage(
      [{ profileSlug: "bookmark", properties: { title: "Post" } }],
      {
        imageUrl: "https://blog.test/og.jpg",
        sourceUrl: "https://blog.test/post",
      },
      () => linkDeclared
    );
    expect(one!.properties).toEqual({
      title: "Post",
      [CAPTURED_MEDIA_URLS_PROPERTY]: ["https://blog.test/og.jpg"],
    });
  });
});

describe("planMediaCopy (idempotency)", () => {
  it("skips what is copied, what failed permanently, and transient failures past 3 attempts", () => {
    const urls = planMediaCopy({
      presentation: declared,
      properties: {
        [CAPTURED_MEDIA_URLS_PROPERTY]: [
          "https://a.test/copied.png",
          "https://a.test/svg",
          "https://a.test/flaky",
          "https://a.test/dead",
          "https://a.test/new.png",
        ],
      },
      systemData: {
        media: [copy("https://a.test/copied.png")],
        mediaCopyFailures: [
          {
            sourceUrl: "https://a.test/svg",
            reason: "not_image",
            attempts: 1,
            lastAttemptAt: "x",
          },
          {
            sourceUrl: "https://a.test/flaky",
            reason: "timeout",
            attempts: 2,
            lastAttemptAt: "x",
          },
          {
            sourceUrl: "https://a.test/dead",
            reason: "timeout",
            attempts: 3,
            lastAttemptAt: "x",
          },
        ],
      },
    });
    expect(urls).toEqual(["https://a.test/flaky", "https://a.test/new.png"]);
  });
});

describe("mergeMediaSystemData", () => {
  it("appends new copies, dedupes by sourceUrl, counts failures, clears a failure that now succeeded", () => {
    const current = {
      eventEndFired: true,
      media: [copy("https://a.test/1.png", "doc-1")],
      mediaCopyFailures: [
        {
          sourceUrl: "https://a.test/2.png",
          reason: "timeout",
          attempts: 1,
          lastAttemptAt: "t0",
        },
        {
          sourceUrl: "https://a.test/3.png",
          reason: "http_5xx",
          attempts: 1,
          lastAttemptAt: "t0",
        },
      ],
    };
    const next = mergeMediaSystemData(current, {
      copied: [
        copy("https://a.test/1.png", "doc-dup"),
        copy("https://a.test/2.png", "doc-2"),
      ],
      failed: [{ sourceUrl: "https://a.test/3.png", reason: "timeout" }],
      at: "t1",
    });
    expect(next.media.map((m) => m.documentId)).toEqual(["doc-1", "doc-2"]);
    expect(next.mediaCopyFailures).toEqual([
      {
        sourceUrl: "https://a.test/3.png",
        reason: "timeout",
        attempts: 2,
        lastAttemptAt: "t1",
      },
    ]);
    // Only the two owned keys come back — the writer jsonb_sets exactly these.
    expect(Object.keys(next).sort()).toEqual([
      "media",
      "mediaCopyFailures",
      "pruned",
    ]);
  });
});

describe("foldCapturedImage (capture reader og:image)", () => {
  const page = "https://blog.test/post";
  const img = "https://blog.test/og.jpg";
  const decl = (slug: string) => (slug === "bookmark" ? declared : null);

  it("fills the declared property of the entity that IS the page", () => {
    const out = foldCapturedImage(
      [
        { profileSlug: "bookmark", properties: { url: page } },
        { profileSlug: "bookmark", properties: { url: "https://other.test" } },
      ],
      { imageUrl: img, sourceUrl: page },
      decl
    );
    expect(out[0]!.properties).toEqual({ url: page, image: img });
    expect(out[1]!.properties).toEqual({ url: "https://other.test" });
  });

  it("never overwrites a declared value — appends to media-urls instead", () => {
    const [one] = foldCapturedImage(
      [
        {
          profileSlug: "bookmark",
          properties: { url: page, image: "https://x.test/mine.png" },
        },
      ],
      { imageUrl: img, sourceUrl: page },
      decl
    );
    expect(one!.properties).toEqual({
      url: page,
      image: "https://x.test/mine.png",
      [CAPTURED_MEDIA_URLS_PROPERTY]: [img],
    });
  });

  it("leaves a kind with no presentation untouched", () => {
    const input = [{ profileSlug: "note", properties: { url: page } }];
    expect(
      foldCapturedImage(input, { imageUrl: img, sourceUrl: page }, decl)
    ).toEqual(input);
  });
});

describe("declared fallbacks are copied in the resolver's order", () => {
  const asset = presentationFromUiHints({
    presentation: {
      family: "media",
      media: {
        source: { property: "asset-document-id" },
        fallbacks: [{ property: "asset-url" }],
      },
    },
  });
  const UPLOADED = "6f1c2a3b-0000-4000-8000-000000000001";

  it("an external fallback is copied when the source is empty", () => {
    expect(
      collectMediaSourceUrls({ "asset-url": "https://x.test/logo.png" }, asset)
    ).toEqual(["https://x.test/logo.png"]);
  });

  it("never while an earlier source already answers (an upload)", () => {
    expect(
      collectMediaSourceUrls(
        { "asset-document-id": UPLOADED, "asset-url": "https://x.test/l.png" },
        asset
      )
    ).toEqual([]);
  });

  it("the backfill scope names every declared property but a link's page", () => {
    expect(declaredMediaProperties(asset)).toEqual([
      "asset-document-id",
      "asset-url",
    ]);
    expect(declaredMediaProperties(linkDeclared)).toEqual([]);
  });
});

describe("a copy whose document is gone is owed again", () => {
  it("planMediaCopy re-plans the URL of a copy outside the live set", () => {
    const systemData = { media: [copy("https://x.test/a.png", "doc-gone")] };
    const input = {
      properties: { image: "https://x.test/a.png" },
      systemData,
      presentation: declared,
    };
    expect(planMediaCopy(input)).toEqual([]);
    expect(
      planMediaCopy({ ...input, liveCopyDocumentIds: new Set<string>() })
    ).toEqual(["https://x.test/a.png"]);
  });
});

describe("mergeMediaSystemData prunes what the entity no longer names", () => {
  const OLD = "https://x.test/old.png";
  const NEW = "https://x.test/new.png";
  const run = { copied: [copy(NEW, "doc-new")], failed: [], at: "t" };

  it("a copy of a URL the entity stopped naming is pruned (its blob is the caller's to discard)", () => {
    const next = mergeMediaSystemData({ media: [copy(OLD, "doc-old")] }, run, {
      sources: new Set([NEW]),
    });
    expect(next.media.map((m) => m.documentId)).toEqual(["doc-new"]);
    expect(next.pruned.map((m) => m.documentId)).toEqual(["doc-old"]);
  });

  it("a copy whose document is known dead is pruned; an unknown one is kept", () => {
    const next = mergeMediaSystemData(
      { media: [copy(OLD, "doc-dead"), copy(NEW, "doc-concurrent")] },
      { copied: [], failed: [], at: "t" },
      { sources: new Set([OLD, NEW]), deadDocumentIds: new Set(["doc-dead"]) }
    );
    expect(next.media.map((m) => m.documentId)).toEqual(["doc-concurrent"]);
    expect(next.pruned.map((m) => m.documentId)).toEqual(["doc-dead"]);
  });

  it("without `keep` nothing is pruned (append-only, the old contract)", () => {
    const next = mergeMediaSystemData({ media: [copy(OLD, "doc-old")] }, run);
    expect(next.pruned).toEqual([]);
    expect(next.media).toHaveLength(2);
  });
});

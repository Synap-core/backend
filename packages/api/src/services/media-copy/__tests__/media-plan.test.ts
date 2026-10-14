import { describe, expect, it } from "vitest";
import type { EntityMediaCopy } from "@synap-core/types/presentation";
import {
  CAPTURED_MEDIA_URLS_PROPERTY,
  collectMediaSourceUrls,
  mergeMediaSystemData,
  planMediaCopy,
  presentationOf,
} from "../media-plan.js";
import { foldCapturedImage } from "../capture-media.js";

const declared = presentationOf({
  presentation: { family: "record", media: { source: { property: "image" } } },
});
/** The real link shape (catalog bookmark/article): the declared property IS the page. */
const linkDeclared = presentationOf({
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

describe("presentationOf", () => {
  it("reads a valid declaration, null for none or invalid", () => {
    expect(declared?.media?.source).toEqual({ property: "image" });
    expect(presentationOf({})).toBeNull();
    expect(presentationOf(null)).toBeNull();
    expect(presentationOf({ presentation: { family: "nope" } })).toBeNull();
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
      { imageUrl: "https://blog.test/og.jpg", sourceUrl: "https://blog.test/post" },
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
    expect(Object.keys(next).sort()).toEqual(["media", "mediaCopyFailures"]);
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

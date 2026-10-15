/**
 * Site adapters, end to end through `readBuiltin` (registry → adapter →
 * guarded fetch → normalizeUrlRead), on recorded-shape bodies. NO live
 * network: `fetch` is a fake that throws on any request it was not told
 * about. Every adapter has a success row AND a failure row that must come back
 * `blocked` / `failed` — never an empty `ok`.
 */
import { describe, expect, it } from "vitest";
import { readBuiltin } from "../read-builtin.js";
import {
  ARTICLE_HTML,
  ARXIV_EMPTY,
  ARXIV_FEED,
  BSKY_RESOLVE,
  BSKY_THREAD,
  FX_STATUS,
  GH_README,
  GH_REPO,
  HN_ITEM,
  REDDIT_RSS,
  TIKTOK_OEMBED,
  VIMEO_OEMBED,
  WIKI_EXTRACT,
  WIKI_SUMMARY,
  X_OEMBED,
  YOUTUBE_OEMBED,
  fakeWeb,
  json,
  respond,
} from "./fixtures.js";

const NOW = () => new Date("2026-10-15T00:00:00Z");
const read = (url: string, fetch: ReturnType<typeof fakeWeb>) =>
  readBuiltin(url, { fetch, now: NOW });

describe("oEmbed adapters", () => {
  it("YouTube: title, author, cover — partial (no description, no transcript)", async () => {
    const web = fakeWeb([
      ["https://www.youtube.com/oembed?", () => json(YOUTUBE_OEMBED)],
    ]);
    const r = await read("https://www.youtube.com/watch?v=dQw4w9WgXcQ", web);
    expect(r.status).toBe("partial");
    expect(r.via.id).toBe("builtin:adapter:youtube");
    expect(r.title).toBe("Never Gonna Give You Up");
    expect(r.author).toBe("Rick Astley");
    expect(r.media).toEqual([
      {
        url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        kind: "image",
        role: "cover",
        order: 0,
        width: 480,
        height: 360,
      },
    ]);
    expect(web.calls).toHaveLength(1);
  });

  it("YouTube private video (401) is blocked: private", async () => {
    const web = fakeWeb([
      [
        "https://www.youtube.com/oembed?",
        () =>
          respond("Unauthorized", { status: 401, contentType: "text/html" }),
      ],
    ]);
    const r = await read("https://youtu.be/abc", web);
    expect(r.status).toBe("blocked");
    expect(r.blocked?.reason).toBe("private");
  });

  it("TikTok: caption as text, cover — partial; the TikTok PAGE is never fetched", async () => {
    const web = fakeWeb([
      ["https://www.tiktok.com/oembed?", () => json(TIKTOK_OEMBED)],
    ]);
    const r = await read(
      "https://www.tiktok.com/@scout2015/video/6718335390845095173",
      web
    );
    expect(r.status).toBe("partial");
    expect(r.text).toContain("Scramble up ur name");
    expect(r.author).toBe("Scout, Suki & Stella");
    expect(r.media?.[0]?.role).toBe("cover");
    expect(
      web.calls.every((c) => c.startsWith("https://www.tiktok.com/oembed?"))
    ).toBe(true);
  });

  it("TikTok unknown to oEmbed → blocked needs_reader / install_reader, no page fetch", async () => {
    const web = fakeWeb([
      ["https://www.tiktok.com/oembed?", () => respond("{}", { status: 404 })],
    ]);
    const r = await read("https://www.tiktok.com/@a/video/1", web);
    expect(r.blocked).toEqual({
      reason: "needs_reader",
      nextStep: "install_reader",
      detail: expect.any(String),
    });
    expect(web.calls).toHaveLength(1);
  });

  it("TikTok oEmbed down (network) → still never the page: needs_reader", async () => {
    const web = fakeWeb([]);
    const r = await read("https://www.tiktok.com/@a/video/1", web);
    expect(r.status).toBe("blocked");
    expect(r.blocked?.reason).toBe("needs_reader");
    expect(
      web.calls.some((c) => c.startsWith("https://www.tiktok.com/@"))
    ).toBe(false);
  });

  it("Vimeo: description is the text — ok, with duration", async () => {
    const web = fakeWeb([
      ["https://vimeo.com/api/oembed.json?", () => json(VIMEO_OEMBED)],
    ]);
    const r = await read("https://vimeo.com/76979871", web);
    expect(r.status).toBe("ok");
    expect(r.via.id).toBe("builtin:adapter:vimeo");
    expect(r.text).toContain("rebuilt our player");
    expect(r.publishedAt).toBe("2013-10-15T00:00:00.000Z");
    expect(r.fields?.durationSec).toBe(62);
  });

  it("Vimeo non-video URL (oEmbed 404) falls through to the page rung", async () => {
    const web = fakeWeb([
      [
        "https://vimeo.com/api/oembed.json?",
        () => respond("", { status: 404 }),
      ],
      [
        "https://vimeo.com/features",
        () => respond(ARTICLE_HTML, { contentType: "text/html" }),
      ],
    ]);
    const r = await read("https://vimeo.com/features", web);
    expect(r.via.id).toBe("builtin:article");
    expect(r.status).toBe("ok");
  });
});

describe("X", () => {
  it("oEmbed + FixTweet: full text, author, date, photo + video with cover, counts", async () => {
    const web = fakeWeb([
      ["https://publish.twitter.com/oembed?", () => json(X_OEMBED)],
      ["https://api.fxtwitter.com/jack/status/20", () => json(FX_STATUS)],
    ]);
    const r = await read("https://x.com/jack/status/20", web);
    expect(r.status).toBe("ok");
    expect(r.via.id).toBe("builtin:adapter:x");
    expect(r.text).toBe("just setting up my twttr");
    expect(r.author).toBe("jack");
    expect(r.publishedAt).toBe("2006-03-21T20:50:14.000Z");
    expect(r.media?.map((m) => [m.kind, m.role])).toEqual([
      ["image", "slide"],
      ["video", "slide"],
    ]);
    expect(r.media?.[1]?.durationSec).toBe(12.5);
    expect(r.fields).toMatchObject({
      likes: 300000,
      reposts: 120000,
      replies: 16000,
    });
  });

  it("FixTweet down: oEmbed alone is a partial read (media unknown)", async () => {
    const web = fakeWeb([
      ["https://publish.twitter.com/oembed?", () => json(X_OEMBED)],
      ["https://api.fxtwitter.com/", () => respond("", { status: 500 })],
    ]);
    const r = await read("https://twitter.com/jack/status/20", web);
    expect(r.status).toBe("partial");
    expect(r.text).toBe("just setting up my twttr");
    expect(r.media).toBeUndefined();
  });

  it("both 404 → blocked not_found", async () => {
    const web = fakeWeb([
      [
        "https://publish.twitter.com/oembed?",
        () => respond("", { status: 404 }),
      ],
      [
        "https://api.fxtwitter.com/",
        () => json({ code: 404, message: "NOT_FOUND" }, 404),
      ],
      // the page rung is tried after a failed adapter; x.com is a JS shell
      [
        "https://x.com/",
        () =>
          respond("<html><body></body></html>", {
            status: 404,
            contentType: "text/html",
          }),
      ],
    ]);
    const r = await read("https://x.com/a/status/1", web);
    expect(r.status).toBe("blocked");
    expect(r.blocked?.reason).toBe("not_found");
  });

  it("protected post → blocked private", async () => {
    const web = fakeWeb([
      [
        "https://publish.twitter.com/oembed?",
        () => respond("", { status: 403 }),
      ],
      [
        "https://api.fxtwitter.com/",
        () => json({ code: 401, message: "PRIVATE_TWEET" }, 401),
      ],
    ]);
    const r = await read("https://x.com/a/status/1", web);
    expect(r.blocked?.reason).toBe("private");
  });
});

describe("Bluesky", () => {
  it("resolves the handle, reads the post with its image", async () => {
    const web = fakeWeb([
      [
        "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=bsky.app",
        () => json(BSKY_RESOLVE),
      ],
      [
        "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at%3A%2F%2Fdid%3Aplc%3Az72i7hdynmk6r22z27h6tvur%2Fapp.bsky.feed.post%2F3l6oveex3ii2l",
        () => json(BSKY_THREAD),
      ],
    ]);
    const r = await read(
      "https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l",
      web
    );
    expect(r.status).toBe("ok");
    expect(r.text).toContain("Video is here!");
    expect(r.author).toBe("Bluesky");
    expect(r.authorUrl).toBe("https://bsky.app/profile/bsky.app");
    expect(r.media?.[0]).toMatchObject({
      kind: "image",
      width: 1000,
      height: 750,
    });
    expect(r.fields).toMatchObject({ likes: 30, reposts: 20 });
  });

  it("an author who hides from logged-out viewers → blocked login_wall", async () => {
    const thread = structuredClone(BSKY_THREAD);
    thread.thread.post.author.labels = [
      { val: "!no-unauthenticated" },
    ] as never;
    const web = fakeWeb([
      [
        "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread",
        () => json(thread),
      ],
    ]);
    const r = await read(
      "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/x",
      web
    );
    expect(r.blocked?.reason).toBe("login_wall");
    expect(r.text).toBeUndefined();
  });

  it("a missing post → blocked not_found", async () => {
    const web = fakeWeb([
      [
        "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle",
        () => json(BSKY_RESOLVE),
      ],
      [
        "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread",
        () => json({ error: "NotFound", message: "Post not found" }, 400),
      ],
    ]);
    const r = await read("https://bsky.app/profile/bsky.app/post/nope", web);
    expect(r.blocked?.reason).toBe("not_found");
  });
});

describe("Hacker News", () => {
  it("story title + top-level comments as text, counts as fields", async () => {
    const web = fakeWeb([
      ["https://hn.algolia.com/api/v1/items/8863", () => json(HN_ITEM)],
    ]);
    const r = await read("https://news.ycombinator.com/item?id=8863", web);
    expect(r.status).toBe("ok");
    expect(r.title).toBe("My YC app: Dropbox - Throw away your USB drive");
    expect(r.text).toContain("BrandonM: I have a few qualms");
    expect(r.text).toContain("nickb: Very cool.");
    expect(r.fields).toMatchObject({
      points: 111,
      comments: 3,
      linkUrl: "http://www.getdropbox.com/u/2/screencast.html",
    });
    expect(r.canonicalUrl).toBe("https://news.ycombinator.com/item?id=8863");
  });

  it("unknown item (404) → blocked not_found", async () => {
    const web = fakeWeb([
      [
        "https://hn.algolia.com/api/v1/items/",
        () => json({ status: 404, error: "Not Found" }, 404),
      ],
      [
        "https://news.ycombinator.com/item",
        () => respond("No such item.", { contentType: "text/html" }),
      ],
    ]);
    const r = await read("https://news.ycombinator.com/item?id=1", web);
    expect(r.status).toBe("blocked");
    expect(r.blocked?.reason).toBe("not_found");
  });
});

describe("GitHub", () => {
  it("repo metadata + README", async () => {
    const web = fakeWeb([
      [
        "https://api.github.com/repos/kepano/defuddle/readme",
        () =>
          respond(GH_README, {
            contentType: "application/vnd.github.raw+json",
          }),
      ],
      ["https://api.github.com/repos/kepano/defuddle", () => json(GH_REPO)],
    ]);
    const r = await read("https://github.com/kepano/defuddle", web);
    expect(r.status).toBe("ok");
    expect(r.title).toBe("kepano/defuddle");
    expect(r.text).toContain("Extract the main content");
    expect(r.text).toContain("# Defuddle");
    expect(r.fields).toMatchObject({
      stars: 4200,
      language: "TypeScript",
      license: "MIT",
      topics: "readability, html",
    });
  });

  it("an issue URL is not the adapter's: the page rung reads it", async () => {
    const web = fakeWeb([
      [
        "https://github.com/a/b/issues/1",
        () => respond(ARTICLE_HTML, { contentType: "text/html" }),
      ],
    ]);
    const r = await read("https://github.com/a/b/issues/1", web);
    expect(r.via.id).toBe("builtin:article");
  });

  it("rate-limited API + unreachable page → failed with the API's reason", async () => {
    const web = fakeWeb([
      [
        "https://api.github.com/",
        () => json({ message: "API rate limit exceeded for 1.2.3.4." }, 403),
      ],
      [
        "https://github.com/a/b",
        () => respond("", { status: 503, contentType: "text/html" }),
      ],
    ]);
    const r = await read("https://github.com/a/b", web);
    expect(r.status).toBe("failed");
    expect(r.via.id).toBe("builtin:adapter:github");
    expect(r.error).toMatch(/rate limit/);
  });
});

describe("Wikipedia", () => {
  it("full plain extract + lead image + description", async () => {
    const web = fakeWeb([
      [
        "https://en.wikipedia.org/api/rest_v1/page/summary/Ada_Lovelace",
        () => json(WIKI_SUMMARY),
      ],
      ["https://en.wikipedia.org/w/api.php?", () => json(WIKI_EXTRACT)],
    ]);
    const r = await read("https://en.wikipedia.org/wiki/Ada_Lovelace", web);
    expect(r.status).toBe("ok");
    expect(r.text).toContain("Analytical Engine");
    expect(r.text).toContain("Early life");
    expect(r.media?.[0]?.url).toBe("https://upload.wikimedia.org/ada.jpg");
    expect(r.fields).toMatchObject({
      lang: "en",
      description: "English mathematician (1815–1852)",
    });
  });

  it("summary down → failed, never an empty ok", async () => {
    const web = fakeWeb([
      [
        "https://en.wikipedia.org/api/rest_v1/",
        () => respond("", { status: 503 }),
      ],
      [
        "https://en.wikipedia.org/w/api.php?",
        () => respond("", { status: 503 }),
      ],
      [
        "https://en.wikipedia.org/wiki/",
        () => respond("", { status: 503, contentType: "text/html" }),
      ],
    ]);
    const r = await read("https://en.wikipedia.org/wiki/Ada_Lovelace", web);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/503/);
  });
});

describe("arXiv", () => {
  it("abstract, authors, category, pdf link", async () => {
    const web = fakeWeb([
      [
        "https://export.arxiv.org/api/query?id_list=1706.03762",
        () => respond(ARXIV_FEED, { contentType: "application/atom+xml" }),
      ],
    ]);
    const r = await read("https://arxiv.org/abs/1706.03762", web);
    expect(r.status).toBe("ok");
    expect(r.title).toBe("Attention Is All You Need");
    expect(r.text).toMatch(/^The dominant sequence transduction/);
    expect(r.author).toBe("Ashish Vaswani, Noam Shazeer");
    expect(r.fields).toMatchObject({
      primaryCategory: "cs.CL",
      pdfUrl: "http://arxiv.org/pdf/1706.03762v7",
    });
    expect(r.publishedAt).toBe("2017-06-12T17:57:34.000Z");
  });

  it("a /pdf/ link reads the same paper (no PDF fetch)", async () => {
    const web = fakeWeb([
      [
        "https://export.arxiv.org/api/query?id_list=1706.03762v7",
        () => respond(ARXIV_FEED, { contentType: "application/atom+xml" }),
      ],
    ]);
    const r = await read("https://arxiv.org/pdf/1706.03762v7", web);
    expect(r.title).toBe("Attention Is All You Need");
    expect(web.calls).toHaveLength(1);
  });

  it("unknown id (empty feed) → blocked not_found", async () => {
    const web = fakeWeb([
      [
        "https://export.arxiv.org/",
        () => respond(ARXIV_EMPTY, { contentType: "application/atom+xml" }),
      ],
    ]);
    const r = await read("https://arxiv.org/abs/2401.99999", web);
    expect(r.blocked?.reason).toBe("not_found");
  });
});

describe("Reddit", () => {
  it("post body + comments from the thread's .rss", async () => {
    const web = fakeWeb([
      [
        "https://www.reddit.com/r/programming/comments/abc123/why/.rss",
        () =>
          respond(REDDIT_RSS, {
            contentType: "application/atom+xml; charset=UTF-8",
          }),
      ],
    ]);
    const r = await read(
      "https://old.reddit.com/r/programming/comments/abc123/why/",
      web
    );
    expect(r.status).toBe("ok");
    expect(r.title).toBe("Why we moved off microservices");
    expect(r.author).toBe("alice");
    expect(r.text).toContain("We merged 40 services into one deployable");
    expect(r.text).not.toContain("submitted by");
    expect(r.text).toContain("bob: Same experience here.");
    expect(r.fields).toMatchObject({
      subreddit: "programming",
      linkUrl: "https://example.com/blog/monolith",
      comments: 1,
    });
    expect(r.media?.[0]?.url).toBe(
      "https://external-preview.redd.it/thumb.jpg?auto=webp&s=1"
    );
  });

  it("Reddit refusing the pod (403) → blocked, next step: your browser", async () => {
    const web = fakeWeb([
      [
        "https://www.reddit.com/",
        () =>
          respond("<html><body>blocked by network security</body></html>", {
            status: 403,
            contentType: "text/html",
          }),
      ],
    ]);
    const r = await read("https://www.reddit.com/r/x/comments/abc/t/", web);
    expect(r.status).toBe("blocked");
    expect(r.blocked?.reason).toBe("ip_reputation");
    expect(r.blocked?.nextStep).toBe("open_in_my_browser");
  });
});

describe("Google Docs", () => {
  it("a public doc's plain-text export (following the download redirect through the guard)", async () => {
    const web = fakeWeb([
      [
        "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/export?format=txt",
        () =>
          respond(
            "\ufeffQuarterly plan\r\n\r\nGoals for Q4 are written here.",
            {
              contentType: "text/plain; charset=utf-8",
            }
          ),
      ],
    ]);
    const r = await read(
      "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing",
      web
    );
    expect(r.status).toBe("ok");
    expect(r.title).toBe("Quarterly plan");
    expect(r.text).toContain("Goals for Q4");
    expect(r.via.id).toBe("builtin:adapter:google-docs");
  });

  it("a private doc (export lands on Google's sign-in HTML) → blocked private, no text", async () => {
    const web = fakeWeb([
      [
        "https://docs.google.com/document/d/",
        () =>
          respond(
            "<html><title>Sign in - Google Accounts</title><input type=password></html>",
            { contentType: "text/html; charset=utf-8" }
          ),
      ],
    ]);
    const r = await read(
      "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit",
      web
    );
    expect(r.status).toBe("blocked");
    expect(r.blocked?.reason).toBe("private");
    expect(r.text).toBeUndefined();
  });
});

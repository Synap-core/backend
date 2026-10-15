/**
 * The built-in ladder as a whole: routing, the never-fetched hosts, the SSRF
 * door, the page rung's honest outcomes, and that the default network path IS
 * `safePublicFetch` (reachability, not shape). No live network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@synap/shared-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/shared-utils")>();
  return { ...actual, safePublicFetch: vi.fn() };
});

import { safePublicFetch } from "@synap/shared-utils";
import { LIGHT_READ_TEXT_MAX } from "../../../library/light-read.js";
import { readBuiltin } from "../read-builtin.js";
import { BUILTIN_READ_TEXT_MAX } from "../limits.js";
import {
  POD_NEVER_FETCHES,
  SITE_ADAPTERS,
  findSiteAdapter,
} from "../registry.js";
import {
  ARTICLE_HTML,
  CLOUDFLARE_CHALLENGE_HTML,
  JS_SHELL_HTML,
  fakeWeb,
  respond,
} from "./fixtures.js";

const NOW = () => new Date("2026-10-15T00:00:00Z");
const publicFetch = vi.mocked(safePublicFetch);

beforeEach(() => publicFetch.mockReset());

describe("readBuiltin — the ladder", () => {
  it("an article page: fetched through safePublicFetch by default, body read, stamped builtin:article", async () => {
    publicFetch.mockResolvedValue(
      respond(ARTICLE_HTML, { contentType: "text/html; charset=utf-8" })
    );
    const r = await readBuiltin("https://example.com/blog/monolith", {
      now: NOW,
    });
    expect(publicFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init, hops] = publicFetch.mock.calls[0]!;
    expect(calledUrl).toBe("https://example.com/blog/monolith");
    expect(hops).toBe(3);
    expect(JSON.stringify(init?.headers).toLowerCase()).not.toContain("cookie");
    expect(r).toMatchObject({
      status: "ok",
      sourceUrl: "https://example.com/blog/monolith",
      via: {
        id: "builtin:article",
        billed: false,
        readAt: "2026-10-15T00:00:00.000Z",
      },
      title: "Migrating to a monolith",
    });
    expect(r.text).toContain("Paragraph 12 of the real article body");
    expect(r.text).not.toContain("TEASER-ONLY");
  });

  it("an Instagram URL: no adapter, the pod never fetches it → blocked needs_reader / install_reader", async () => {
    const web = fakeWeb([]);
    for (const url of [
      "https://www.instagram.com/p/C8abcDEF/",
      "https://instagram.com/reel/C8abcDEF/",
      "https://www.tiktok.com/@someone",
    ]) {
      const r = await readBuiltin(url, { fetch: web, now: NOW });
      expect(r.status).toBe("blocked");
      expect(r.blocked?.reason).toBe("needs_reader");
      expect(r.blocked?.nextStep).toBe("install_reader");
      expect(r.via.id).toBe("builtin:policy");
    }
    expect(findSiteAdapter("https://www.instagram.com/p/C8abcDEF/")).toBeNull();
    expect(web.calls).toEqual([]);
  });

  it("a private address is refused before ANY request (not even to an API)", async () => {
    const web = fakeWeb([]);
    for (const url of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest",
      "http://[::1]/",
    ]) {
      const r = await readBuiltin(url, { fetch: web, now: NOW });
      expect(r.status).toBe("blocked");
      expect(r.blocked?.reason).toBe("unsupported");
    }
    expect(web.calls).toEqual([]);
  });

  it("a redirect into a private address (the door throws) → blocked, not failed-and-retry", async () => {
    // (A fake, not the mocked door: vitest 4 reports a spy's rejection as a
    // test error even when the caller handles it.)
    const web = fakeWeb([]);
    const doorRefusal = Object.assign(
      async (url: string) => {
        web.calls.push(url);
        throw new Error(
          "Blocked outbound request: URL '10.0.0.5' resolves to a private or reserved address"
        );
      },
      { calls: [] as string[] }
    );
    const r = await readBuiltin("https://short.example.com/x", {
      fetch: doorRefusal,
      now: NOW,
    });
    expect(web.calls).toEqual(["https://short.example.com/x"]);
    expect(r.status).toBe("blocked");
    expect(r.blocked?.reason).toBe("unsupported");
  });

  it("a challenge served with 403 → blocked challenge (not ip_reputation, not failed)", async () => {
    const web = fakeWeb([
      [
        "https://shop.example.com/",
        () =>
          respond(CLOUDFLARE_CHALLENGE_HTML, {
            status: 403,
            contentType: "text/html",
          }),
      ],
    ]);
    const r = await readBuiltin("https://shop.example.com/item/1", {
      fetch: web,
      now: NOW,
    });
    expect(r.blocked).toEqual({
      reason: "challenge",
      nextStep: "open_in_my_browser",
      detail: expect.any(String),
    });
  });

  it("a challenge served with 200 → blocked challenge", async () => {
    const web = fakeWeb([
      [
        "https://shop.example.com/",
        () => respond(CLOUDFLARE_CHALLENGE_HTML, { contentType: "text/html" }),
      ],
    ]);
    const r = await readBuiltin("https://shop.example.com/item/1", {
      fetch: web,
      now: NOW,
    });
    expect(r.blocked?.reason).toBe("challenge");
  });

  it("a JS shell → partial with its metadata", async () => {
    const web = fakeWeb([
      [
        "https://app.example.com/",
        () => respond(JS_SHELL_HTML, { contentType: "text/html" }),
      ],
    ]);
    const r = await readBuiltin("https://app.example.com/", {
      fetch: web,
      now: NOW,
    });
    expect(r.status).toBe("partial");
    expect(r.title).toBe("Dashboard App");
  });

  it("a 404 page → blocked not_found; a 500 → failed; a network error → failed", async () => {
    const notFound = await readBuiltin("https://example.com/gone", {
      fetch: fakeWeb([
        [
          "https://example.com/",
          () => respond("nope", { status: 404, contentType: "text/html" }),
        ],
      ]),
      now: NOW,
    });
    expect(notFound.blocked?.reason).toBe("not_found");
    const broken = await readBuiltin("https://example.com/x", {
      fetch: fakeWeb([
        ["https://example.com/", () => respond("", { status: 500 })],
      ]),
      now: NOW,
    });
    expect(broken).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/500/),
    });
    const down = await readBuiltin("https://example.com/x", {
      fetch: fakeWeb([]),
      now: NOW,
    });
    expect(down.status).toBe("failed");
  });

  it("a PDF link → blocked unsupported with attach_file (the page reader does not read files)", async () => {
    const web = fakeWeb([
      [
        "https://example.com/",
        () => respond("%PDF-1.7", { contentType: "application/pdf" }),
      ],
    ]);
    const r = await readBuiltin("https://example.com/paper.pdf", {
      fetch: web,
      now: NOW,
    });
    expect(r.blocked).toMatchObject({
      reason: "unsupported",
      nextStep: "attach_file",
    });
  });

  it("an adapter that throws is a failed read, never a crash", async () => {
    const boom = {
      id: "boom",
      name: "Boom",
      urls: ["boom.example.com"],
      read: async () => {
        throw new Error("kaput");
      },
    };
    const web = fakeWeb([
      ["https://boom.example.com/", () => respond("", { status: 502 })],
    ]);
    const r = await readBuiltin("https://boom.example.com/a", {
      fetch: web,
      now: NOW,
      adapters: [boom],
    });
    expect(r.status).toBe("failed");
    expect(r.via.id).toBe("builtin:adapter:boom");
    expect(r.error).toMatch(/kaput/);
  });

  it("not a URL → failed, no request", async () => {
    const web = fakeWeb([]);
    const r = await readBuiltin("see this https://example.com", {
      fetch: web,
      now: NOW,
    });
    expect(r.status).toBe("failed");
    expect(web.calls).toEqual([]);
  });
});

describe("the registry (the ONE host table)", () => {
  it("every adapter declares at least one valid pattern and has a unique id", () => {
    expect(SITE_ADAPTERS.length).toBeGreaterThanOrEqual(11);
    const ids = new Set(SITE_ADAPTERS.map((a) => a.id));
    expect(ids.size).toBe(SITE_ADAPTERS.length);
    for (const a of SITE_ADAPTERS) expect(a.urls.length).toBeGreaterThan(0);
  });

  it("routes each family to its adapter, most specific first", () => {
    const cases: Array<[string, string | null]> = [
      ["https://www.youtube.com/watch?v=x", "youtube"],
      ["https://m.youtube.com/shorts/x", "youtube"],
      ["https://youtu.be/x", "youtube"],
      ["https://www.tiktok.com/@a/video/1", "tiktok"],
      ["https://vimeo.com/76979871", "vimeo"],
      ["https://x.com/a/status/1", "x"],
      ["https://mobile.twitter.com/a/status/1", "x"],
      ["https://bsky.app/profile/a.b/post/x", "bluesky"],
      ["https://news.ycombinator.com/item?id=1", "hacker-news"],
      ["https://github.com/a/b", "github"],
      ["https://fr.wikipedia.org/wiki/Paris", "wikipedia"],
      ["https://arxiv.org/abs/1706.03762", "arxiv"],
      ["https://old.reddit.com/r/a/comments/b/c/", "reddit"],
      ["https://docs.google.com/document/d/abc/edit", "google-docs"],
      ["https://www.instagram.com/p/x/", null],
      ["https://example.com/a", null],
    ];
    for (const [url, id] of cases) {
      expect([url, findSiteAdapter(url)?.id ?? null]).toEqual([url, id]);
    }
  });

  it("Instagram and TikTok pages are on the never-fetched list", () => {
    expect(POD_NEVER_FETCHES).toEqual(
      expect.arrayContaining(["*.instagram.com", "*.tiktok.com"])
    );
  });

  it("the text cap IS the light read's", () => {
    expect(BUILTIN_READ_TEXT_MAX).toBe(LIGHT_READ_TEXT_MAX);
  });
});

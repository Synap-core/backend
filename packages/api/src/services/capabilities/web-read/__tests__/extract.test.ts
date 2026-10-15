/**
 * Article extraction — discriminating fixtures. Each row is chosen because a
 * plausible WRONG rule gives a different answer on it:
 *  - og:description ≠ body          → rules out "og:description first" (the old S1 reader)
 *  - JS shell with metadata         → rules out "title present ⇒ ok"
 *  - challenge pages                → rules out "200 + some text ⇒ ok"
 *  - an article ABOUT challenges    → rules out a naive keyword match
 *  - a sign-in wall                 → rules out "short ⇒ partial" for walls
 *  - a short page whose paragraph holds a date → rules out "defuddle's body
 *    always wins" (its clutter pass dropped that paragraph as a byline)
 */
import { describe, expect, it } from "vitest";
import { extractFromHtml } from "../extract.js";
import { readSentPage } from "../read-builtin.js";
import {
  ARTICLE_ABOUT_CHALLENGES_HTML,
  ARTICLE_HTML,
  CLOUDFLARE_CHALLENGE_HTML,
  DATADOME_HTML,
  JS_SHELL_HTML,
  LOGIN_WALL_HTML,
} from "./fixtures.js";

const URL_ = "https://example.com/blog/monolith?utm=x";

describe("extractFromHtml", () => {
  it("reads the article BODY, not og:description, with JSON-LD/OG metadata", () => {
    const r = extractFromHtml(ARTICLE_HTML, URL_);
    expect(r.status).toBe("ok");
    expect(r.text).toContain("Paragraph 1 of the real article body");
    expect(r.text).toContain("Paragraph 12 of the real article body");
    expect(r.text).not.toContain("TEASER-ONLY");
    // site chrome is not the article
    expect(r.text).not.toContain("subscribe to our newsletter");
    expect(r.text!.length).toBeGreaterThan(1_000);
    expect(r.title).toBe("Migrating to a monolith");
    expect(r.author).toBe("Ada Byron");
    expect(r.siteName).toBe("Example Blog");
    expect(r.publishedAt).toMatch(/^2026-09-30/);
    expect(r.canonicalUrl).toBe("https://example.com/blog/monolith");
    expect(r.media).toEqual([
      {
        url: "https://example.com/img/cover.png",
        kind: "image",
        role: "cover",
        order: 0,
      },
    ]);
  });

  it("a JS app shell is partial — metadata kept, no pretend body", () => {
    const r = extractFromHtml(JS_SHELL_HTML, "https://app.example.com/");
    expect(r.status).toBe("partial");
    expect(r.title).toBe("Dashboard App");
    expect((r.text ?? "").length).toBeLessThan(400);
    expect(r.media?.[0]?.url).toBe("https://cdn.example.com/og.png");
  });

  it.each([
    ["Cloudflare", CLOUDFLARE_CHALLENGE_HTML],
    ["DataDome", DATADOME_HTML],
  ])("a %s challenge page is blocked: challenge, never data", (_n, html) => {
    const r = extractFromHtml(html, URL_);
    expect(r).toEqual({
      status: "blocked",
      blocked: {
        reason: "challenge",
        nextStep: "open_in_my_browser",
        detail: expect.any(String),
      },
    });
    expect(r.text).toBeUndefined();
  });

  it("an article that MENTIONS a challenge is still an article", () => {
    const r = extractFromHtml(ARTICLE_ABOUT_CHALLENGES_HTML, URL_);
    expect(r.status).toBe("ok");
    expect(r.text).toContain("Cloudflare was checking your browser");
  });

  it("a sign-in wall is blocked: login_wall with open_in_my_browser", () => {
    const r = extractFromHtml(
      LOGIN_WALL_HTML,
      "https://social.example.com/p/1"
    );
    expect(r.status).toBe("blocked");
    expect(r.blocked?.reason).toBe("login_wall");
    expect(r.blocked?.nextStep).toBe("open_in_my_browser");
  });

  it("a paywalled stub (isAccessibleForFree:false, no prose) is blocked: paywall", () => {
    const html = `<html><head><title>Big scoop</title>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Big scoop","isAccessibleForFree":"False"}</script>
      </head><body><article><p>Subscribe to read the rest.</p></article></body></html>`;
    const r = extractFromHtml(html, "https://news.example.com/scoop");
    expect(r.blocked?.reason).toBe("paywall");
  });

  it("a page with nothing at all is blocked, never an empty ok", () => {
    const r = extractFromHtml(
      "<html><body><div id=app></div></body></html>",
      URL_
    );
    expect(r.status).toBe("blocked");
    expect(r.blocked?.reason).toBe("unsupported");
  });

  it("caps the text at the light-read max", () => {
    const huge = `<html><body><article>${"<p>" + "word ".repeat(30_000) + "</p>"}</article></body></html>`;
    const r = extractFromHtml(huge, URL_);
    expect(r.text!.length).toBe(50_000);
  });
});

describe("readSentPage (the page the person's browser sent)", () => {
  it("a SHORT page keeps the paragraph that holds a date (the readable pass wins when it holds more)", () => {
    const html = `<!doctype html><html><head><title>Plan</title></head><body>
<nav>Home · Pricing</nav><article><h1>Quarterly plan</h1>
<p>We ship the offline sync engine in November. The team meets on 20 November 2026 at 10:00 to review it.</p>
<p>Bring the numbers.</p></article><footer>© Acme</footer></body></html>`;
    const r = extractFromHtml(html, "https://intranet.acme.example/plan");
    expect(r.text).toContain("We ship the offline sync engine in November.");
    expect(r.text).toContain("Bring the numbers.");
    expect(r.text).not.toMatch(/Pricing|© Acme/);
  });

  it("is stamped builtin:page, normalized, and makes no request", () => {
    const r = readSentPage(
      ARTICLE_HTML,
      URL_,
      new Date("2026-10-15T00:00:00Z")
    );
    expect(r.via).toEqual({
      id: "builtin:page",
      name: expect.any(String),
      billed: false,
      readAt: "2026-10-15T00:00:00.000Z",
    });
    expect(r.sourceUrl).toBe(URL_);
    expect(r.status).toBe("ok");
    expect(r.publishedAt).toBe("2026-09-30T08:00:00.000Z");
  });
});

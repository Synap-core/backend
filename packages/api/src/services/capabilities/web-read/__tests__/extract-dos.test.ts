/**
 * Hostile pages cannot pin the pod's CPU. Each case was measured on
 * the pre-fix code; the bound asserted is WALL time on the caller's side.
 *
 *  - 2 000 nested `<div>` (10 KB): defuddle took 25.7 s → now the DOM shape
 *    cap hands it to the linear pass (completes, < 1 s).
 *  - 80 000 unclosed `<form>` (480 KB): the lazy backreference regex took
 *    8.4 s → linear scan (< 200 ms).
 *  - 40 000 unclosed `<article>` (`pick`): 3.0 s → linear.
 *  - 3 000 empty sibling `<div>` (inside the caps, ≈ 3.6 s of defuddle): the
 *    worker deadline terminates it → `failed: extract_timeout`, and the pool
 *    reads the next page normally.
 *
 * NOT covered: a page that is slow for a reason other than these shapes is
 * bounded only by the deadline (asserted by the last case), not made fast.
 */
import { afterAll, describe, expect, it } from "vitest";
import { extractFromHtml } from "../extract.js";
import {
  EXTRACT_TIMEOUT_ERROR,
  extractPage,
  shutdownExtractPool,
} from "../extract-pool.js";
import { readableTextFromHtml, titleTag, metaContent } from "../html.js";
import { readSentPage } from "../read-builtin.js";
import { ARTICLE_HTML } from "./fixtures.js";

const URL_ = "https://example.com/a";

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
}

afterAll(async () => {
  await shutdownExtractPool();
});

describe("extraction stays bounded on hostile markup", () => {
  it("10 KB of 2 000 nested <div> completes in < 1 s (DOM cap → linear pass)", () => {
    const html = `<html><body>${"<div>".repeat(2_000)}deep words here${"</div>".repeat(2_000)}</body></html>`;
    expect(html.length).toBeGreaterThan(10_000);
    const { value, ms } = timed(() => extractFromHtml(html, URL_));
    expect(ms).toBeLessThan(1_000);
    expect(value.status).not.toBe("ok"); // a few words: partial, honestly
    expect(value.text).toContain("deep words here");
  });

  it("480 KB of unclosed <form> through the readable-text pass in < 200 ms", () => {
    const html = "<html><body>" + "<form>".repeat(80_000);
    expect(html.length).toBeGreaterThan(480_000);
    const { ms } = timed(() => readableTextFromHtml(html, 50_000));
    expect(ms).toBeLessThan(200);
  });

  // Each row is a page the OLD pattern for that pass took seconds on
  // (measured: <article> 3.0 s, comments 27 s, <title> 8.6 s, <meta 40 s,
  // a 30 KB attribute run 2.7 s); the page is the bare markup, so every pass
  // scans all of it.
  it.each([
    ["unclosed <article>", "<article>".repeat(40_000)],
    ["unclosed comments", "<!--".repeat(120_000)],
    ["tags with no '>'", "<p".repeat(200_000)],
    ["unclosed <title>", "<title>".repeat(60_000)],
    ["<meta with no '>'", "<meta".repeat(100_000)],
    [
      "a 30 KB attribute run in a meta tag",
      `<meta name="x" ${"a".repeat(30_000)}>`,
    ],
  ])("%s: every regex pass is linear (< 200 ms)", (_name, html) => {
    const { ms } = timed(() => {
      readableTextFromHtml(html, 50_000);
      titleTag(html);
      metaContent(html, "og:title");
    });
    expect(ms).toBeLessThan(200);
  });

  it("the same unclosed-<form> page through the whole extractor (worker) in < 1 s", async () => {
    await extractPage(ARTICLE_HTML, URL_); // warm the worker (tsx start-up)
    const html = "<html><body>" + "<form>".repeat(80_000);
    const t = performance.now();
    const read = await extractPage(html, URL_);
    expect(performance.now() - t).toBeLessThan(1_000);
    expect(["blocked", "partial", "failed"]).toContain(read.status);
  });

  it("past the deadline the worker is terminated: failed extract_timeout, then the next page reads", async () => {
    await extractPage(ARTICLE_HTML, URL_); // warm
    // Inside the DOM caps, ≈ 3.6 s of defuddle: only the deadline stops it.
    const slow = `<html><body>${"<div></div>".repeat(3_000)}</body></html>`;
    const t = performance.now();
    const read = await extractPage(slow, URL_, { deadlineMs: 300 });
    expect(performance.now() - t).toBeLessThan(1_000);
    // Classed transient: a later try reads the page, the item is never unreadable for it.
    expect(read).toEqual({
      status: "failed",
      error: EXTRACT_TIMEOUT_ERROR,
      errorClass: "extract_timeout",
    });

    const next = await extractPage(ARTICLE_HTML, URL_);
    expect(next.status).toBe("ok");
    expect(next.text).toContain("Paragraph 1 of the real article body");
  }, 30_000);

  it("the event loop keeps turning while a page extracts", async () => {
    await extractPage(ARTICLE_HTML, URL_); // warm
    const slow = `<html><body>${"<div></div>".repeat(3_000)}</body></html>`;
    let ticks = 0;
    const iv = setInterval(() => (ticks += 1), 10);
    await extractPage(slow, URL_, { deadlineMs: 500 });
    clearInterval(iv);
    expect(ticks).toBeGreaterThan(10); // a blocked loop would tick ~0 times
  }, 30_000);

  it("a normal article reads unchanged through the worker (readSentPage)", async () => {
    const viaWorker = await readSentPage(ARTICLE_HTML, URL_);
    const inline = extractFromHtml(ARTICLE_HTML, URL_);
    expect(viaWorker.status).toBe(inline.status);
    expect(viaWorker.text).toBe(inline.text);
    expect(viaWorker.title).toBe(inline.title);
    expect(viaWorker.media).toEqual(inline.media);
  });
});

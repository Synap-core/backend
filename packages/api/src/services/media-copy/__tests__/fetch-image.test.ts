/**
 * The streamed, capped, magic-byte-checked fetch. No network: the fetcher is
 * injected; the real SSRF validator is used unless a test says otherwise.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fetchExternalImage,
  fetchGuardedBytes,
  MEDIA_COPY_MAX_SIDE,
  PERMANENT_FETCH_FAILURES,
} from "../fetch-image.js";
import { png } from "./fixtures.js";

/** A body served chunk by chunk; counts how many chunks the reader pulled. */
function streamed(
  chunks: Uint8Array[] | (() => Uint8Array),
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (typeof chunks === "function") {
          // "Endless" but bounded, so a broken cap fails the test instead of
          // eating memory: 64 × 256 B is far past any cap used here.
          if (pulled++ >= 64) controller.close();
          else controller.enqueue(chunks());
          return;
        }
        const next = chunks[pulled++];
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
      // No pre-pull: `pulled` counts only what the reader asked for.
    },
    { highWaterMark: 0 }
  );
  const res = new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { "content-type": "image/png" },
  });
  return {
    fetch: vi.fn(async () => res),
    pulled: () => pulled,
    cancelled: () => cancelled,
  };
}

const URL_OK = "https://cdn.example.com/a.png";

describe("fetchExternalImage", () => {
  it("returns the bytes, the SNIFFED type and the size", async () => {
    const s = streamed([png(64, 32)], {
      headers: { "content-type": "application/octet-stream" },
    });
    const got = await fetchExternalImage(URL_OK, { fetch: s.fetch });
    expect(got).toMatchObject({
      ok: true,
      mime: "image/png",
      width: 64,
      height: 32,
    });
  });

  it("aborts a lying server: no Content-Length, an endless body — cut at the cap", async () => {
    const head = png(10, 10);
    let first = true;
    const s = streamed(() => {
      if (first) {
        first = false;
        return head;
      }
      return new Uint8Array(256);
    });
    const got = await fetchExternalImage(URL_OK, {
      fetch: s.fetch,
      maxBytes: 1024,
    });
    expect(got).toEqual({ ok: false, reason: "too_large" });
    // 33 + 4×256 > 1024 on the 5th chunk: stopped there, not drained.
    expect(s.pulled()).toBeLessThanOrEqual(6);
    expect(s.cancelled()).toBe(true);
  });

  it("aborts a server whose Content-Length lies LOW", async () => {
    const s = streamed([png(10, 10), new Uint8Array(2000)], {
      headers: { "content-type": "image/png", "content-length": "40" },
    });
    expect(
      await fetchExternalImage(URL_OK, { fetch: s.fetch, maxBytes: 1024 })
    ).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("refuses a truthful Content-Length over the cap before reading", async () => {
    const s = streamed([png(10, 10)], {
      headers: { "content-type": "image/png", "content-length": "999999" },
    });
    expect(
      await fetchExternalImage(URL_OK, { fetch: s.fetch, maxBytes: 1024 })
    ).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(s.pulled()).toBe(0);
  });

  it("refuses SVG even served as image/svg+xml — and stops after the first chunk", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'
    );
    const s = streamed([svg, new Uint8Array(100)], {
      headers: { "content-type": "image/svg+xml" },
    });
    expect(await fetchExternalImage(URL_OK, { fetch: s.fetch })).toEqual({
      ok: false,
      reason: "not_image",
    });
    expect(s.pulled()).toBe(1);
  });

  it("refuses HTML that claims to be image/png (Content-Type is never trusted)", async () => {
    const html = new TextEncoder().encode(
      "<!doctype html><html><body>not an image</body></html>"
    );
    const s = streamed([html], { headers: { "content-type": "image/png" } });
    expect(await fetchExternalImage(URL_OK, { fetch: s.fetch })).toEqual({
      ok: false,
      reason: "not_image",
    });
  });

  it("never fetches a private address", async () => {
    const s = streamed([png(1, 1)]);
    expect(
      await fetchExternalImage("http://169.254.169.254/latest", {
        fetch: s.fetch,
      })
    ).toEqual({
      ok: false,
      reason: "blocked",
    });
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it("classifies HTTP errors", async () => {
    // A link that no longer serves the file (an expired CDN signature) is
    // `expired`, not the generic 4xx — a client hides "Try again" for it.
    for (const status of [403, 404, 410]) {
      expect(
        await fetchExternalImage(URL_OK, {
          fetch: streamed([], { status }).fetch,
        })
      ).toEqual({ ok: false, reason: "expired" });
    }
    expect(
      await fetchExternalImage(URL_OK, {
        fetch: streamed([], { status: 400 }).fetch,
      })
    ).toEqual({ ok: false, reason: "http_4xx" });
    expect(PERMANENT_FETCH_FAILURES.has("expired")).toBe(true);
    expect(
      await fetchExternalImage(URL_OK, {
        fetch: streamed([], { status: 503 }).fetch,
      })
    ).toEqual({ ok: false, reason: "http_5xx" });
  });

  it("408 and 429 mean 'later', not a permanent 4xx", async () => {
    for (const status of [408, 429]) {
      expect(
        await fetchExternalImage(URL_OK, {
          fetch: streamed([], { status }).fetch,
        })
      ).toEqual({ ok: false, reason: "http_retry_later" });
    }
    expect(PERMANENT_FETCH_FAILURES.has("http_retry_later")).toBe(false);
  });

  it("refuses a header claiming a canvas past the side or pixel bound", async () => {
    for (const [w, h] of [
      [MEDIA_COPY_MAX_SIDE + 1, 8],
      [12_000, 12_000],
    ] as const) {
      expect(
        await fetchExternalImage(URL_OK, { fetch: streamed([png(w, h)]).fetch })
      ).toEqual({ ok: false, reason: "too_large" });
    }
    expect(
      await fetchExternalImage(URL_OK, {
        fetch: streamed([png(MEDIA_COPY_MAX_SIDE, 8)]).fetch,
      })
    ).toMatchObject({ ok: true, width: MEDIA_COPY_MAX_SIDE });
  });
});

describe("fetchGuardedBytes (any file through the same guarded door)", () => {
  const PDF = new TextEncoder().encode("%PDF-1.7 a small document");
  it("returns the bytes and the declared type, without sniffing", async () => {
    const s = streamed([PDF], {
      headers: { "content-type": "application/pdf; charset=binary" },
    });
    const got = await fetchGuardedBytes("https://files.example.com/a.pdf", {
      maxBytes: 1024,
      timeoutMs: 5_000,
      fetch: s.fetch,
    });
    expect(got).toEqual({
      ok: true,
      bytes: Buffer.from(PDF),
      contentType: "application/pdf; charset=binary",
    });
    // The pinned door was asked, with an Accept header and the redirect cap.
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a truthful Content-Length over the cap BEFORE reading a byte", async () => {
    const s = streamed([PDF], {
      headers: { "content-type": "application/pdf", "content-length": "5000" },
    });
    expect(
      await fetchGuardedBytes("https://files.example.com/a.pdf", {
        maxBytes: 1024,
        timeoutMs: 5_000,
        fetch: s.fetch,
      })
    ).toEqual({ ok: false, reason: "too_large" });
    expect(s.pulled()).toBe(0);
  });

  it("cuts a lying server at the cap; an empty body and a 404 are refused", async () => {
    const endless = streamed(() => new Uint8Array(256), {
      headers: { "content-type": "application/octet-stream" },
    });
    expect(
      await fetchGuardedBytes("https://files.example.com/x", {
        maxBytes: 1024,
        timeoutMs: 5_000,
        fetch: endless.fetch,
      })
    ).toEqual({ ok: false, reason: "too_large" });
    expect(endless.pulled()).toBeLessThanOrEqual(6);
    expect(
      await fetchGuardedBytes("https://files.example.com/x", {
        maxBytes: 1024,
        timeoutMs: 5_000,
        fetch: streamed([]).fetch,
      })
    ).toEqual({ ok: false, reason: "empty" });
    expect(
      await fetchGuardedBytes("https://files.example.com/x", {
        maxBytes: 1024,
        timeoutMs: 5_000,
        fetch: streamed([PDF], { status: 404 }).fetch,
      })
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("a private address never reaches the fetcher (the real SSRF guard)", async () => {
    const s = streamed([PDF]);
    expect(
      await fetchGuardedBytes("http://169.254.169.254/latest/meta-data", {
        maxBytes: 1024,
        timeoutMs: 5_000,
        fetch: s.fetch,
      })
    ).toEqual({ ok: false, reason: "blocked" });
    expect(s.fetch).not.toHaveBeenCalled();
  });
});

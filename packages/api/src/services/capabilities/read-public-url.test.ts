/**
 * Public-URL reader. No live network: `safeExternalFetch` is the SSRF helper
 * and is mocked. `validateExternalUrl` stays the real guard, wrapped so the
 * test can see that it was consulted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@synap/shared-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/shared-utils")>();
  return {
    ...actual,
    validateExternalUrl: vi.fn((raw: string) =>
      actual.validateExternalUrl(raw)
    ),
    safeExternalFetch: vi.fn(),
  };
});

import { safeExternalFetch, validateExternalUrl } from "@synap/shared-utils";
import { readPublicUrl } from "./read-public-url.js";

const fetchMock = vi.mocked(safeExternalFetch);
const validateMock = vi.mocked(validateExternalUrl);

function httpResponse(
  body: string,
  init?: { status?: number; contentType?: string }
): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: {
      "content-type": init?.contentType ?? "text/html; charset=utf-8",
    },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  validateMock.mockClear();
});

describe("readPublicUrl", () => {
  it("skips prose and anything that is not exactly one http(s) URL", async () => {
    for (const input of [
      "see https://example.com/a",
      "https://example.com/a is neat",
      "https://example.com/a https://example.com/b",
      "not a url",
      "",
      "ftp://example.com/a",
      "javascript:alert(1)",
    ]) {
      expect(await readPublicUrl(input)).toEqual({ kind: "skip" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(validateMock).not.toHaveBeenCalled();
  });

  it("reads a lone URL with surrounding whitespace", async () => {
    fetchMock.mockResolvedValue(
      httpResponse(
        '<meta property="og:title" content="Hello"><meta property="og:description" content="Body">'
      )
    );
    const read = await readPublicUrl("  https://example.com/a  ");
    expect(read.kind).toBe("read");
    if (read.kind === "read")
      expect(read.sourceUrl).toBe("https://example.com/a");
  });

  it("maps oEmbed JSON to title, author, and image", async () => {
    fetchMock.mockResolvedValue(
      httpResponse(
        JSON.stringify({
          title: "A talk",
          author_name: "Ada",
          thumbnail_url: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
          html: "<p>Ignored when a title is present, kept as text.</p>",
        }),
        { contentType: "application/json" }
      )
    );

    expect(await readPublicUrl("https://www.youtube.com/watch?v=abc")).toEqual({
      kind: "read",
      title: "A talk",
      author: "Ada",
      text: "Ignored when a title is present, kept as text.",
      imageUrl: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
      sourceUrl: "https://www.youtube.com/watch?v=abc",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetched = String(fetchMock.mock.calls[0]?.[0]);
    expect(
      fetched.startsWith("https://www.youtube.com/oembed?format=json&url=")
    ).toBe(true);
    expect(fetched).toContain(
      encodeURIComponent("https://www.youtube.com/watch?v=abc")
    );
    expect(validateMock).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=abc"
    );
    expect(validateMock).toHaveBeenCalledWith(fetched);
  });

  it.each([
    ["https://youtu.be/abc", "https://www.youtube.com/oembed?format=json&url="],
    ["https://www.tiktok.com/@a/video/1", "https://www.tiktok.com/oembed?url="],
    [
      "https://twitter.com/a/status/1",
      "https://publish.twitter.com/oembed?url=",
    ],
    ["https://x.com/a/status/1", "https://publish.twitter.com/oembed?url="],
  ])("%s uses oEmbed %s", async (page, prefix) => {
    fetchMock.mockResolvedValue(
      httpResponse(JSON.stringify({ title: "T", author_name: "A" }), {
        contentType: "application/json",
      })
    );
    await readPublicUrl(page);
    const called = String(fetchMock.mock.calls[0]?.[0]);
    expect(called.startsWith(prefix)).toBe(true);
    expect(called).toContain(encodeURIComponent(new URL(page).toString()));
  });

  it("reads Open Graph tags, including swapped attributes and entities", async () => {
    fetchMock.mockResolvedValue(
      httpResponse(`<!doctype html><html><head>
        <meta content="Hello &amp; co" property="og:title">
        <meta property="og:description" content="A short desc">
        <meta property="og:image" content="/img.png">
        <meta name="author" content="Bea">
      </head><body><p>not the excerpt</p></body></html>`)
    );

    const read = await readPublicUrl("https://example.com/a");
    expect(read).toEqual({
      kind: "read",
      title: "Hello & co",
      author: "Bea",
      text: "A short desc",
      imageUrl: "https://example.com/img.png",
      sourceUrl: "https://example.com/a",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/a",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
      3
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.stringify(init.headers).toLowerCase()).not.toContain("cookie");
    expect(validateMock).toHaveBeenCalledWith("https://example.com/a");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("falls back to stripped text, capped, when og:description is absent", async () => {
    const long = "word ".repeat(800);
    fetchMock.mockResolvedValue(
      httpResponse(
        `<title>Plain</title><script>secret()</script><p>${long}</p>`
      )
    );
    const read = await readPublicUrl("https://example.com/plain");
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.title).toBe("Plain");
    expect(read.author).toBeNull();
    expect(read.text.length).toBeLessThanOrEqual(2000);
    expect(read.text.startsWith("Plain word")).toBe(true);
    expect(read.text).not.toContain("secret");
    expect(read.imageUrl).toBeNull();
  });

  it("uses the SSRF helper and does not fetch a private URL", async () => {
    const blocked = await readPublicUrl("http://127.0.0.1/secret");
    expect(blocked).toEqual({
      kind: "unavailable",
      sourceUrl: "http://127.0.0.1/secret",
    });
    expect(validateMock).toHaveBeenCalledWith("http://127.0.0.1/secret");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockClear();
    validateMock.mockClear();
    const metadata = await readPublicUrl("http://169.254.169.254/latest");
    expect(metadata.kind).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns unavailable when the fetch fails, without throwing", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(readPublicUrl("https://example.com/down")).resolves.toEqual({
      kind: "unavailable",
      sourceUrl: "https://example.com/down",
    });
    expect(fetchMock).toHaveBeenCalled();

    fetchMock.mockResolvedValue(httpResponse("nope", { status: 403 }));
    await expect(readPublicUrl("https://example.com/private")).resolves.toEqual(
      {
        kind: "unavailable",
        sourceUrl: "https://example.com/private",
      }
    );
  });
});

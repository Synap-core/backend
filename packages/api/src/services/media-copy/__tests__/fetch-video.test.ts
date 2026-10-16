/**
 * The streamed video download: guarded like images, sniffed before a byte is
 * stored, capped while streaming, hashed as it passes. The SSRF cases run the
 * REAL `safePublicFetch` against a local server with a stubbed resolver (the
 * door's own test technique), so "redirect into a private address" is the
 * door refusing, not a mock saying so.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { safePublicFetch, type AddressResolver } from "@synap/shared-utils";
import {
  fetchExternalVideoToSink,
  libraryMediaVideoMaxBytes,
  LIBRARY_MEDIA_VIDEO_MAX_BYTES_DEFAULT,
} from "../fetch-video.js";
import { sniffVideoType } from "../video-sniff.js";
import { mp4Head, webmHead } from "./fixtures.js";

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
          if (pulled++ >= 256) controller.close();
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
    },
    { highWaterMark: 0 }
  );
  const res = new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { "content-type": "video/mp4" },
  });
  return {
    fetch: vi.fn(async () => res),
    pulled: () => pulled,
    cancelled: () => cancelled,
  };
}

/** A sink that drains the body like storage's uploadStream does. */
function collectingSink() {
  const calls: string[] = [];
  let collected = Buffer.alloc(0);
  const sink = vi.fn(async (body: AsyncIterable<Uint8Array>, mime: string) => {
    calls.push(mime);
    const parts: Buffer[] = [];
    for await (const c of body) parts.push(Buffer.from(c));
    collected = Buffer.concat(parts);
    return { key: "stored-key" };
  });
  return { sink, calls, bytes: () => collected };
}

const URL_OK = "https://cdn.example.com/v.mp4";

describe("sniffVideoType", () => {
  it("mp4 (ftyp + video brand) and webm (EBML + webm DocType) only", () => {
    expect(sniffVideoType(mp4Head("isom"))).toBe("video/mp4");
    expect(sniffVideoType(mp4Head("mp42"))).toBe("video/mp4");
    expect(sniffVideoType(webmHead("webm"))).toBe("video/webm");
    // QuickTime, HEIF photo and Matroska share the containers, not the types.
    expect(sniffVideoType(mp4Head("qt  "))).toBeNull();
    expect(sniffVideoType(mp4Head("heic"))).toBeNull();
    expect(sniffVideoType(webmHead("matroska"))).toBeNull();
    expect(
      sniffVideoType(new TextEncoder().encode("<!doctype html><html></html>"))
    ).toBeNull();
  });
});

describe("libraryMediaVideoMaxBytes", () => {
  it("1 GiB by default; a positive integer env overrides; junk falls back", () => {
    expect(libraryMediaVideoMaxBytes({})).toBe(1024 ** 3);
    expect(LIBRARY_MEDIA_VIDEO_MAX_BYTES_DEFAULT).toBe(1024 ** 3);
    expect(
      libraryMediaVideoMaxBytes({ SYNAP_LIBRARY_MEDIA_VIDEO_MAX_BYTES: "5000" })
    ).toBe(5000);
    expect(
      libraryMediaVideoMaxBytes({ SYNAP_LIBRARY_MEDIA_VIDEO_MAX_BYTES: "-1" })
    ).toBe(1024 ** 3);
    expect(
      libraryMediaVideoMaxBytes({ SYNAP_LIBRARY_MEDIA_VIDEO_MAX_BYTES: "1e9" })
    ).toBe(1024 ** 3);
    // documents.size is an int4.
    expect(
      libraryMediaVideoMaxBytes({
        SYNAP_LIBRARY_MEDIA_VIDEO_MAX_BYTES: "9999999999",
      })
    ).toBe(2_147_483_647);
  });

  it("the name it shipped under is still read; the new name wins when both are set", () => {
    expect(
      libraryMediaVideoMaxBytes({ LIBRARY_MEDIA_VIDEO_MAX_BYTES: "7000" })
    ).toBe(7000);
    expect(
      libraryMediaVideoMaxBytes({
        LIBRARY_MEDIA_VIDEO_MAX_BYTES: "7000",
        SYNAP_LIBRARY_MEDIA_VIDEO_MAX_BYTES: "9000",
      })
    ).toBe(9000);
    // An empty new name (compose passes `''`) does not hide the old one.
    expect(
      libraryMediaVideoMaxBytes({
        LIBRARY_MEDIA_VIDEO_MAX_BYTES: "7000",
        SYNAP_LIBRARY_MEDIA_VIDEO_MAX_BYTES: "",
      })
    ).toBe(7000);
  });
});

describe("fetchExternalVideoToSink", () => {
  it("streams an mp4 into the sink: sniffed type, byte count, exactly the bytes (no second hash pass)", async () => {
    const head = mp4Head("isom");
    const rest = new Uint8Array(500).fill(7);
    const s = streamed([head, rest], {
      headers: { "content-type": "application/octet-stream" },
    });
    const c = collectingSink();
    const got = await fetchExternalVideoToSink(URL_OK, c.sink, {
      fetch: s.fetch,
    });
    expect(got).toMatchObject({
      ok: true,
      mime: "video/mp4",
      bytes: head.byteLength + 500,
      stored: { key: "stored-key" },
    });
    expect(c.bytes().byteLength).toBe(head.byteLength + 500);
    // The sink (storage) hashes as the bytes pass; the fetcher does not.
    expect(got).not.toHaveProperty("sha256");
    expect(c.calls).toEqual(["video/mp4"]);
  });

  it("a webm passes; a body shorter than the sniff head is still judged", async () => {
    const s = streamed([webmHead("webm")], {
      headers: { "content-type": "video/webm" },
    });
    const c = collectingSink();
    const got = await fetchExternalVideoToSink(URL_OK, c.sink, {
      fetch: s.fetch,
    });
    expect(got).toMatchObject({ ok: true, mime: "video/webm" });
  });

  it("HTML disguised as mp4 is refused BEFORE the sink sees a byte", async () => {
    const html = new TextEncoder().encode(
      "<!doctype html><html><body><script>alert(1)</script> padding padding padding</body></html>"
    );
    const s = streamed([html, new Uint8Array(1000)], {
      headers: { "content-type": "video/mp4" },
    });
    const c = collectingSink();
    const got = await fetchExternalVideoToSink(URL_OK, c.sink, {
      fetch: s.fetch,
    });
    expect(got).toEqual({ ok: false, reason: "not_video" });
    expect(c.sink).not.toHaveBeenCalled();
    expect(s.cancelled()).toBe(true);
  });

  it("an over-cap stream with no Content-Length is CUT OFF mid-stream; the sink rejects", async () => {
    const head = mp4Head("isom");
    let first = true;
    const s = streamed(() => {
      if (first) {
        first = false;
        return head;
      }
      return new Uint8Array(256);
    });
    const c = collectingSink();
    const got = await fetchExternalVideoToSink(URL_OK, c.sink, {
      fetch: s.fetch,
      maxBytes: 2_000,
    });
    expect(got).toEqual({ ok: false, reason: "too_large" });
    expect(c.sink).toHaveBeenCalledTimes(1);
    // Stopped right past the cap: 2000 / 256 ≈ 8 chunks, never the 256 offered.
    expect(s.pulled()).toBeLessThan(12);
    expect(s.cancelled()).toBe(true);
  });

  it("a truthful Content-Length over the cap is refused before a byte is read", async () => {
    const s = streamed([mp4Head("isom")], {
      headers: { "content-type": "video/mp4", "content-length": "5000" },
    });
    const c = collectingSink();
    const got = await fetchExternalVideoToSink(URL_OK, c.sink, {
      fetch: s.fetch,
      maxBytes: 4000,
    });
    expect(got).toEqual({ ok: false, reason: "too_large" });
    expect(s.pulled()).toBe(0);
    expect(c.sink).not.toHaveBeenCalled();
  });

  it("a private-address URL is refused without a request", async () => {
    const s = streamed([mp4Head("isom")]);
    const c = collectingSink();
    for (const url of [
      "http://10.0.0.5/v.mp4",
      "http://169.254.169.254/latest/meta-data",
      "http://localhost/v.mp4",
      "file:///etc/passwd",
    ]) {
      expect(
        await fetchExternalVideoToSink(url, c.sink, { fetch: s.fetch })
      ).toEqual({ ok: false, reason: "blocked" });
    }
    expect(s.fetch).not.toHaveBeenCalled();
    expect(c.sink).not.toHaveBeenCalled();
  });

  it("a stalled body times out (idle), never hangs", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(mp4Head("isom"));
        // …and then nothing, ever.
      },
    });
    const fetch = vi.fn(
      async () =>
        new Response(body, { headers: { "content-type": "video/mp4" } })
    );
    const c = collectingSink();
    const got = await fetchExternalVideoToSink(URL_OK, c.sink, {
      fetch,
      idleTimeoutMs: 50,
    });
    expect(got).toEqual({ ok: false, reason: "timeout" });
  });

  it("a storage failure is store_failed, with its cause", async () => {
    const s = streamed([mp4Head("isom"), new Uint8Array(10)]);
    const boom = new Error("bucket gone");
    const got = await fetchExternalVideoToSink(
      URL_OK,
      async (body) => {
        for await (const _ of body) throw boom;
        return null;
      },
      { fetch: s.fetch }
    );
    expect(got).toEqual({ ok: false, reason: "store_failed", cause: boom });
  });

  it("maps statuses like images (404 permanent, 503 transient)", async () => {
    const c = collectingSink();
    for (const [status, reason] of [
      [404, "expired"],
      [400, "http_4xx"],
      [503, "http_5xx"],
      [429, "http_retry_later"],
    ] as const) {
      const s = streamed([], { status });
      expect(
        await fetchExternalVideoToSink(URL_OK, c.sink, { fetch: s.fetch })
      ).toEqual({ ok: false, reason });
    }
  });
});

describe("fetchExternalVideoToSink through the REAL safePublicFetch", () => {
  let server: http.Server;
  let port = 0;
  const seen: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url === "/redirect-internal") {
        res.writeHead(302, {
          location: `http://internal.test:${port}/secret.mp4`,
        });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.concat([Buffer.from(mp4Head("isom")), Buffer.alloc(100)]));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const resolve: AddressResolver = async (host) =>
    (
      ({
        "cdn.test": ["127.0.0.1"],
        "internal.test": ["10.0.0.5"],
        "rebind.test": ["169.254.169.254"],
      }) as Record<string, string[]>
    )[host]?.map((address) => ({ address, family: 4 as const })) ?? [];
  const door: NonNullable<
    Parameters<typeof fetchExternalVideoToSink>[2]
  >["fetch"] = (url, init, hops) =>
    safePublicFetch(url, init, hops, {
      resolve,
      isAllowedAddress: (a) => a === "127.0.0.1",
      allowedPorts: "any",
    });

  it("downloads from a vetted host", async () => {
    const c = collectingSink();
    const got = await fetchExternalVideoToSink(
      `http://cdn.test:${port}/v.mp4`,
      c.sink,
      { fetch: door }
    );
    expect(got).toMatchObject({ ok: true, mime: "video/mp4" });
  });

  it("a redirect INTO a private address is refused at that hop; nothing stored", async () => {
    const before = seen.length;
    const c = collectingSink();
    const got = await fetchExternalVideoToSink(
      `http://cdn.test:${port}/redirect-internal`,
      c.sink,
      { fetch: door }
    );
    expect(got).toEqual({ ok: false, reason: "blocked" });
    expect(seen.slice(before)).toEqual(["/redirect-internal"]);
    expect(c.sink).not.toHaveBeenCalled();
  });

  it("a hostname that resolves to the metadata address is refused (DNS rebinding)", async () => {
    const c = collectingSink();
    const got = await fetchExternalVideoToSink(
      `http://rebind.test:${port}/v.mp4`,
      c.sink,
      { fetch: door }
    );
    expect(got).toEqual({ ok: false, reason: "blocked" });
    expect(c.sink).not.toHaveBeenCalled();
  });
});

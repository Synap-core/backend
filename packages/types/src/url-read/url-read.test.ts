import { describe, expect, it } from "vitest";
import {
  isExpiredSignedMediaUrl,
  signedMediaUrlExpiresAt,
  URL_READ_MEDIA_MAX,
  isValidUrlPattern,
  matchUrlPattern,
  normalizeUrlRead,
  readReaderStamp,
  urlPatternSpecificity,
  type ReaderStamp,
  isBroadUrlPattern,
  isTransientUrlReadFailure,
  URL_READ_FAILURE_CLASSES,
  URL_READ_RETRY_AFTER_MAX_SEC,
} from "./index.js";

const VIA: ReaderStamp = {
  id: "builtin:page",
  name: "Page",
  billed: false,
  readAt: "2026-10-15T00:00:00.000Z",
};
const SRC = "https://example.com/post/1";

describe("matchUrlPattern — the grammar, table-driven", () => {
  // [pattern, url, expected, why]
  const rows: Array<[string, string, boolean, string]> = [
    [
      "instagram.com/p/*",
      "https://www.instagram.com/p/ABC123/",
      true,
      "www. on the URL is ignored",
    ],
    [
      "instagram.com/p/*",
      "https://instagram.com/p/ABC123",
      true,
      "no trailing slash",
    ],
    [
      "instagram.com/p/*",
      "https://instagram.com/p/",
      false,
      "`*` needs one or more chars: /p/ with no id",
    ],
    [
      "instagram.com/p/*",
      "https://instagram.com/p",
      false,
      "no /p/ segment at all",
    ],
    [
      "instagram.com/p/*",
      "https://www.instagram.com/p/ABC/?img_index=2",
      true,
      "query ignored, trailing /",
    ],
    [
      "instagram.com/p/*",
      "https://instagram.com/p/ABC/liked_by/",
      true,
      "followed by /…",
    ],
    [
      "instagram.com/p/*",
      "https://instagram.com/reel/ABC/",
      false,
      "different path",
    ],
    [
      "instagram.com/p/*",
      "https://instagram.com/xp/ABC",
      false,
      "anchored at the start",
    ],
    [
      "instagram.com/p/*",
      "https://notinstagram.com/p/ABC",
      false,
      "exact host, not a suffix",
    ],
    [
      "instagram.com/p/*",
      "https://m.instagram.com/p/ABC",
      false,
      "exact host refuses a subdomain",
    ],
    [
      "instagram.com/p/*",
      "ftp://instagram.com/p/ABC",
      false,
      "non-http scheme refused",
    ],
    [
      "instagram.com/p/*",
      "https://instagram.com/p/ABC#frag",
      true,
      "fragment ignored",
    ],
    [
      "www.instagram.com/p/*",
      "https://instagram.com/p/ABC",
      true,
      "www. on the pattern is ignored too",
    ],
    [
      "*.example.com",
      "https://example.com/",
      true,
      "`*.` matches the bare host",
    ],
    [
      "*.example.com",
      "https://a.b.example.com/x",
      true,
      "`*.` matches any subdomain depth",
    ],
    [
      "*.example.com",
      "https://badexample.com/",
      false,
      "`*.` is a label boundary",
    ],
    [
      "example.com",
      "https://example.com/any/path?x=1",
      true,
      "host-only covers every path",
    ],
    ["example.com/blog", "https://example.com/blog", true, "exact path"],
    [
      "example.com/blog",
      "https://example.com/blog/post",
      true,
      "followed by /…",
    ],
    [
      "example.com/blog",
      "https://example.com/blogger",
      false,
      "path segment boundary",
    ],
    [
      "tiktok.com/@*/video/*",
      "https://www.tiktok.com/@user.name/video/7312345",
      true,
      "literal @ then *",
    ],
    [
      "tiktok.com/@*/video/*",
      "https://www.tiktok.com/@a/b/video/7",
      false,
      "`*` does not cross /",
    ],
    [
      "tiktok.com/**/video/*",
      "https://www.tiktok.com/@a/b/video/7",
      true,
      "`**` crosses /",
    ],
    [
      "example.com/**",
      "https://example.com/",
      true,
      "`**` matches anything, including nothing",
    ],
    ["*", "https://anything.test/x?y", true, "`*` = any https URL"],
    ["*", "http://localhost:3000/", true, "`*` = any http URL"],
    ["*", "javascript:alert(1)", false, "`*` still refuses a non-http scheme"],
    ["*", "mailto:a@b.co", false, "`*` refuses mailto"],
    ["*", "not a url", false, "garbage URL"],
    [
      "EXAMPLE.com/Blog",
      "https://example.COM/Blog",
      true,
      "host is case-insensitive",
    ],
    [
      "example.com/Blog",
      "https://example.com/blog",
      false,
      "path is case-sensitive",
    ],
  ];
  it.each(rows)("%s vs %s → %s (%s)", (pattern, url, expected) => {
    expect(isValidUrlPattern(pattern)).toBe(true);
    expect(matchUrlPattern(pattern, url)).toBe(expected);
  });
});

describe("isValidUrlPattern", () => {
  const valid = [
    "*",
    "example.com",
    "*.example.com",
    "instagram.com/p/*",
    "tiktok.com/@*/video/*",
    "x.com/**",
    "a.b.co/",
  ];
  const invalid = [
    "",
    "   ",
    "https://example.com/p/*",
    "example.com/p?x=1",
    "example.com/#a",
    "exa mple.com",
    "example",
    "*example.com",
    "ex*ample.com",
    "*.*.example.com",
    "example.com/***",
    "**",
    "/p/*",
    "example.com/p/<script>",
  ];
  it.each(valid)("accepts %s", (p) => expect(isValidUrlPattern(p)).toBe(true));
  it.each(invalid)("refuses %j", (p) =>
    expect(isValidUrlPattern(p)).toBe(false)
  );
  it("refuses a non-string without throwing", () => {
    expect(isValidUrlPattern(42 as unknown as string)).toBe(false);
    expect(matchUrlPattern(null as unknown as string, SRC)).toBe(false);
  });
});

describe("urlPatternSpecificity", () => {
  it("follows the formula", () => {
    expect(urlPatternSpecificity("*")).toBe(0);
    expect(urlPatternSpecificity("example.com")).toBe(10 + 11);
    expect(urlPatternSpecificity("*.example.com")).toBe(10 + 11 - 5);
    expect(urlPatternSpecificity("instagram.com/p/*")).toBe(10 + 13 + 2 * 3); // "/p/"
    expect(urlPatternSpecificity("www.example.com")).toBe(
      urlPatternSpecificity("example.com")
    );
    expect(urlPatternSpecificity("not valid")).toBe(-1);
  });
  it("ranks a site reader above a wildcard reader above the catch-all", () => {
    const ranked = ["*", "*.instagram.com", "instagram.com/p/*"].sort(
      (a, b) => urlPatternSpecificity(b) - urlPatternSpecificity(a)
    );
    expect(ranked).toEqual(["instagram.com/p/*", "*.instagram.com", "*"]);
  });
});

describe("normalizeUrlRead", () => {
  it("keeps a good read, stamps the caller's via and sourceUrl, trims strings", () => {
    const r = normalizeUrlRead(
      {
        status: "ok",
        sourceUrl: "https://evil.test/spoof",
        via: { id: "self-stamped", name: "Me", billed: false, readAt: "x" },
        title: "  A post  ",
        author: " Ann ",
        authorUrl: "javascript:alert(1)",
        text: "\n body \n",
        publishedAt: "2026-01-02",
        canonicalUrl: "https://example.com/c",
      },
      SRC,
      VIA
    );
    expect(r).toMatchObject({
      status: "ok",
      sourceUrl: SRC,
      via: VIA,
      title: "A post",
      author: "Ann",
      text: "body",
    });
    expect(r.canonicalUrl).toBe("https://example.com/c");
    expect(r.authorUrl).toBeUndefined();
    expect(r.publishedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("drops non-http(s) media, dedupes, sorts by order and renumbers", () => {
    const r = normalizeUrlRead(
      {
        title: "t",
        media: [
          { url: "data:image/png;base64,AAA", kind: "image" },
          {
            url: "https://cdn.test/b.mp4",
            kind: "video",
            order: 2,
            durationSec: 12,
          },
          {
            url: "https://cdn.test/a.jpg",
            kind: "image",
            order: 1,
            role: "cover",
            width: 10,
            height: -1,
          },
          { url: "https://cdn.test/a.jpg", kind: "image", order: 3 },
          { url: "javascript:x", kind: "image" },
          { url: "https://cdn.test/c.mp3", kind: "audio" },
          "https://cdn.test/raw-string.jpg",
        ],
      },
      SRC,
      VIA
    );
    expect(r.status).toBe("ok");
    expect(r.media).toEqual([
      {
        url: "https://cdn.test/a.jpg",
        kind: "image",
        order: 0,
        role: "cover",
        width: 10,
      },
      {
        url: "https://cdn.test/b.mp4",
        kind: "video",
        order: 1,
        durationSec: 12,
      },
    ]);
  });

  it(`caps media at ${URL_READ_MEDIA_MAX}`, () => {
    const media = Array.from({ length: 20 }, (_, i) => ({
      url: `https://cdn.test/${i}.jpg`,
      kind: "image",
    }));
    const r = normalizeUrlRead({ status: "ok", media }, SRC, VIA);
    expect(r.media).toHaveLength(URL_READ_MEDIA_MAX);
    expect(r.media![URL_READ_MEDIA_MAX - 1]!.url).toBe(
      `https://cdn.test/${URL_READ_MEDIA_MAX - 1}.jpg`
    );
  });

  it("coerces fields to primitives", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const r = normalizeUrlRead(
      {
        status: "partial",
        fields: {
          likes: 3,
          nan: Number.NaN,
          ok: true,
          none: null,
          tags: ["a", " b ", 2],
          obj: { a: 1 },
          empty: "  ",
          cyc: cyclic,
          undef: undefined,
        },
      },
      SRC,
      VIA
    );
    expect(r.status).toBe("partial");
    expect(r.fields).toEqual({
      likes: 3,
      nan: null,
      ok: true,
      none: null,
      tags: "a, b, 2",
      obj: '{"a":1}',
    });
  });

  it("keeps a blocked read with its reason and next step", () => {
    const r = normalizeUrlRead(
      {
        status: "blocked",
        blocked: {
          reason: "login_wall",
          nextStep: "open_in_my_browser",
          detail: " Sign in ",
        },
        title: "ignored",
      },
      SRC,
      VIA
    );
    expect(r).toEqual({
      status: "blocked",
      sourceUrl: SRC,
      via: VIA,
      blocked: {
        reason: "login_wall",
        nextStep: "open_in_my_browser",
        detail: "Sign in",
      },
    });
  });

  it("infers blocked when a reader sends only a blocked object", () => {
    expect(
      normalizeUrlRead(
        { blocked: { reason: "paywall", nextStep: "bogus" } },
        SRC,
        VIA
      )
    ).toMatchObject({
      status: "blocked",
      blocked: { reason: "paywall" },
    });
  });

  // Garbage in → a FAILED read with the reason, never an empty success, never a throw.
  const garbage: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "hello"],
    ["an array", [{ title: "x" }]],
    ["an unknown status", { status: "great", title: "x" }],
    ["ok with no content", { status: "ok" }],
    [
      "ok with only whitespace",
      {
        status: "ok",
        title: "   ",
        text: "",
        media: [{ url: "file:///etc/passwd" }],
      },
    ],
    ["blocked with no reason", { status: "blocked" }],
    [
      "blocked with an unknown reason",
      { status: "blocked", blocked: { reason: "aliens" } },
    ],
  ];
  it.each(garbage)("%s → failed with an error", (_label, raw) => {
    const r = normalizeUrlRead(raw, SRC, VIA);
    expect(r.status).toBe("failed");
    expect(r.error).toEqual(expect.any(String));
    expect(r.error!.length).toBeGreaterThan(0);
    expect(r.via).toBe(VIA);
    expect(r.sourceUrl).toBe(SRC);
  });

  it("carries a failed read's own error", () => {
    expect(
      normalizeUrlRead(
        { status: "failed", error: " 502 from vendor " },
        SRC,
        VIA
      )
    ).toEqual({
      status: "failed",
      sourceUrl: SRC,
      via: VIA,
      error: "502 from vendor",
      // A reader that names no class is `unknown` — never guessed transient.
      errorClass: "unknown",
    });
  });

  it("keeps a known failure class and a bounded Retry-After; drops the rest", () => {
    const r = normalizeUrlRead(
      {
        status: "failed",
        error: "x",
        errorClass: "rate_limited",
        retryAfterSec: 1e9,
      },
      SRC,
      VIA
    );
    expect(r).toMatchObject({
      errorClass: "rate_limited",
      retryAfterSec: URL_READ_RETRY_AFTER_MAX_SEC,
    });
    const junk = normalizeUrlRead(
      { status: "failed", error: "x", errorClass: "teapot", retryAfterSec: -5 },
      SRC,
      VIA
    );
    expect(junk.errorClass).toBe("unknown");
    expect(junk.retryAfterSec).toBeUndefined();
    // The door's own refusal of unusable output is `bad_output`.
    expect(normalizeUrlRead(42, SRC, VIA).errorClass).toBe("bad_output");
    // Retry-After rides a blocked read only when it says retry_later.
    expect(
      normalizeUrlRead(
        {
          status: "blocked",
          blocked: { reason: "ip_reputation", nextStep: "retry_later" },
          retryAfterSec: 30,
        },
        SRC,
        VIA
      ).retryAfterSec
    ).toBe(30);
    expect(
      normalizeUrlRead(
        {
          status: "blocked",
          blocked: { reason: "paywall" },
          retryAfterSec: 30,
        },
        SRC,
        VIA
      ).retryAfterSec
    ).toBeUndefined();
  });

  it("the transient classes are exactly the ones a later try can fix", () => {
    expect(URL_READ_FAILURE_CLASSES.filter(isTransientUrlReadFailure)).toEqual([
      "rate_limited",
      "unavailable",
      "network",
      "extract_busy",
      "extract_timeout",
      "extract_failed",
    ]);
  });

  it("never throws, even on a hostile getter", () => {
    const hostile = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const r = normalizeUrlRead(hostile, SRC, VIA);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("boom");
  });
});

describe("readReaderStamp", () => {
  it("reads a stored stamp, drops junk and wrong-typed optionals", () => {
    expect(
      readReaderStamp({
        ...VIA,
        verbId: "v",
        capabilityId: 3,
        billed: "yes",
        extra: 1,
      })
    ).toEqual({ ...VIA, verbId: "v", billed: false });
  });
  it("undefined without id, name or readAt", () => {
    expect(readReaderStamp({ name: "n", readAt: "t" })).toBeUndefined();
    expect(readReaderStamp({ id: "i", readAt: "t" })).toBeUndefined();
    expect(readReaderStamp({ id: "i", name: "n" })).toBeUndefined();
    expect(readReaderStamp(null)).toBeUndefined();
  });
});

describe("isBroadUrlPattern — reaches past one registrable domain", () => {
  it("`*` and a wildcard over a public second level are broad; one domain is not", () => {
    expect(
      [
        "*",
        "*.co.uk",
        "*.com.au",
        "*.example.com",
        "example.com/a/*",
        "*.github.io",
      ].map(isBroadUrlPattern)
    ).toEqual([true, true, true, false, false, false]);
    // Not even grammar: a host needs two labels.
    expect(isBroadUrlPattern("*.com")).toBe(false);
    expect(isValidUrlPattern("*.com")).toBe(false);
  });
});

describe("signed media links: the expiry built into the URL", () => {
  const at = Date.UTC(2026, 8, 1) / 1000; // 2026-09-01 in epoch seconds
  it("Instagram / Facebook: oe= is a HEX epoch", () => {
    const url = `https://scontent-cdg4-1.cdninstagram.com/v/a.jpg?stp=1&oe=${at.toString(16).toUpperCase()}`;
    expect(signedMediaUrlExpiresAt(url)).toBe(at * 1000);
    expect(
      signedMediaUrlExpiresAt(`https://x.fbcdn.net/a.jpg?oe=${at.toString(16)}`)
    ).toBe(at * 1000);
    expect(isExpiredSignedMediaUrl(url, at * 1000 + 1)).toBe(true);
    expect(isExpiredSignedMediaUrl(url, at * 1000 - 1)).toBe(false);
  });
  it("TikTok: x-expires (else expires) is a DECIMAL epoch on any tiktokcdn* host", () => {
    expect(
      signedMediaUrlExpiresAt(
        `https://p16-sign-va.tiktokcdn.com/c.jpeg?x-expires=${at}`
      )
    ).toBe(at * 1000);
    expect(
      signedMediaUrlExpiresAt(
        `https://p77.tiktokcdn-us.com/c.jpeg?expires=${at}`
      )
    ).toBe(at * 1000);
  });
  it("unknown is never expired: another host, no param, a malformed value", () => {
    expect(
      signedMediaUrlExpiresAt(
        `https://cdn.example.com/a.jpg?oe=${at.toString(16)}`
      )
    ).toBeNull();
    expect(
      signedMediaUrlExpiresAt("https://scontent.cdninstagram.com/a.jpg")
    ).toBeNull();
    expect(
      signedMediaUrlExpiresAt("https://scontent.cdninstagram.com/a.jpg?oe=zz")
    ).toBeNull();
    expect(
      signedMediaUrlExpiresAt("https://evilcdninstagram.com/a.jpg?oe=1")
    ).toBeNull();
    expect(signedMediaUrlExpiresAt("not a url")).toBeNull();
    expect(
      isExpiredSignedMediaUrl("https://cdn.example.com/a.jpg", Date.now())
    ).toBe(false);
  });
});

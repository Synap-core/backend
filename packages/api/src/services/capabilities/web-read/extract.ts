/**
 * Article extraction for ANY page — the HTML the pod fetched, or the page the
 * person's own browser sent. The readable body comes from defuddle (on a
 * linkedom DOM, sync parse only: defuddle never fetches anything here), with
 * the pod's `readableTextFromHtml` as the fallback. Metadata (title, author,
 * date, site, image) comes from defuddle's JSON-LD + Open Graph reading.
 *
 * Adequacy, honestly:
 *  - a bot-check interstitial → `blocked: challenge`;
 *  - a sign-in form with no prose → `blocked: login_wall`;
 *  - JSON-LD `isAccessibleForFree: false` with no prose → `blocked: paywall`;
 *  - less than {@link ADEQUATE_BODY_CHARS} of body (a JS app shell) →
 *    `partial`, metadata kept;
 *  - otherwise `ok`. The body ALWAYS wins over og:description.
 */

import { DefuddleClass } from "defuddle/node";
import { parseHTML } from "linkedom";
import type { UrlReadMedia } from "@synap-core/types/url-read";
import { looksLikeChallenge, siteBlocked, type SiteRead } from "./adapter.js";
import {
  fragmentText,
  httpUrlOrNull,
  metaContent,
  readableTextFromHtml,
  titleTag,
} from "./html.js";
import { ADEQUATE_BODY_CHARS, BUILTIN_READ_TEXT_MAX } from "./limits.js";
import { WEB_READ_PAGE_BYTES_MAX } from "./fetch.js";

interface Parsed {
  title?: string;
  author?: string;
  siteName?: string;
  published?: string;
  image?: string;
  canonical?: string;
  body: string;
  freeAccess?: boolean;
}

/** `isAccessibleForFree` anywhere in the page's schema.org data. */
function accessibleForFree(data: unknown, depth = 0): boolean | undefined {
  if (depth > 6 || data === null || typeof data !== "object") return undefined;
  if (Array.isArray(data)) {
    for (const d of data) {
      const v = accessibleForFree(d, depth + 1);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  const rec = data as Record<string, unknown>;
  const v = rec.isAccessibleForFree;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return !/^false$/i.test(v.trim());
  return accessibleForFree(rec["@graph"], depth + 1);
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function withDefuddle(html: string, url: string): Parsed | null {
  try {
    const { document } = parseHTML(html);
    const doc = document as unknown as Document & {
      styleSheets?: unknown;
      URL: string;
    };
    // The DOM APIs defuddle expects and linkedom lacks (same polyfill as
    // defuddle's own linkedom adapter).
    if (!doc.styleSheets) (doc as { styleSheets: unknown }).styleSheets = [];
    const view = doc.defaultView as
      (Window & { getComputedStyle?: unknown }) | null;
    if (view && !view.getComputedStyle) {
      (view as { getComputedStyle: unknown }).getComputedStyle = () => ({
        display: "",
      });
    }
    try {
      doc.URL = url;
    } catch {
      // a DOM with a read-only URL: defuddle reads `options.url` instead
    }
    const canonical =
      doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
      undefined;
    const result = new DefuddleClass(doc as unknown as Document, {
      url,
      useAsync: false,
      fetch: (() =>
        Promise.reject(
          new Error("the built-in reader never fetches from inside extraction")
        )) as typeof fetch,
    }).parse();
    const body = result.content
      ? fragmentText(result.content, BUILTIN_READ_TEXT_MAX)
      : "";
    return {
      title: nonEmpty(result.title),
      author: nonEmpty(result.author),
      siteName: nonEmpty(result.site),
      published: nonEmpty(result.published),
      image: nonEmpty(result.image),
      canonical,
      body,
      freeAccess: accessibleForFree(result.schemaOrgData),
    };
  } catch {
    return null; // defuddle or the DOM choked on this page: the fallback reads it
  }
}

/** Open Graph + `<title>` + the pod's own readable-text pass. */
function withFallback(html: string): Parsed {
  return {
    title: metaContent(html, "og:title") ?? (titleTag(html) || undefined),
    author: metaContent(html, "author") ?? undefined,
    siteName: metaContent(html, "og:site_name") ?? undefined,
    published: metaContent(html, "article:published_time") ?? undefined,
    image: metaContent(html, "og:image") ?? undefined,
    canonical: metaContent(html, "og:url") ?? undefined,
    body: readableTextFromHtml(html, BUILTIN_READ_TEXT_MAX),
  };
}

const PASSWORD_FIELD = /<input\b[^>]*type\s*=\s*["']?password/i;
const LOGIN_PATH =
  /\/(login|signin|sign-in|sign_in|authwall|accounts\/login|uas\/login)\b/i;

/**
 * Extract a page into a read (no `via`, no `sourceUrl` — the caller stamps).
 * Pure: no network. Used for the page the pod fetched AND for the page the
 * person's browser sent.
 */
export function extractFromHtml(rawHtml: string, url: string): SiteRead {
  const html = rawHtml.slice(0, WEB_READ_PAGE_BYTES_MAX);
  const fallback = withFallback(html);
  const parsed = withDefuddle(html, url);
  // defuddle's body when it found an adequate one; on a SHORT page its
  // clutter pass can drop a real paragraph (one holding a date reads as a
  // byline), so the pod's own readable pass wins there when it holds more.
  const body =
    parsed?.body &&
    (parsed.body.length >= ADEQUATE_BODY_CHARS ||
      parsed.body.length >= fallback.body.length)
      ? parsed.body
      : fallback.body;
  const meta: Parsed = {
    ...fallback,
    ...(parsed ? stripUndefined(parsed) : {}),
    body,
  };

  if (looksLikeChallenge(html, meta.title ?? titleTag(html), body.length)) {
    return siteBlocked(
      "challenge",
      "open_in_my_browser",
      "the site answered a bot check instead of the page"
    );
  }
  const canonicalUrl = httpUrlOrNull(meta.canonical, url) ?? undefined;
  if (
    body.length < ADEQUATE_BODY_CHARS &&
    (PASSWORD_FIELD.test(html) ||
      (canonicalUrl && LOGIN_PATH.test(new URL(canonicalUrl).pathname)))
  ) {
    return siteBlocked(
      "login_wall",
      "open_in_my_browser",
      "the site shows a sign-in form instead of the page"
    );
  }
  if (body.length < ADEQUATE_BODY_CHARS && parsed?.freeAccess === false) {
    return siteBlocked(
      "paywall",
      "open_in_my_browser",
      "the page says it is for subscribers"
    );
  }

  const media: UrlReadMedia[] = [];
  const image = httpUrlOrNull(meta.image, url);
  if (image) media.push({ url: image, kind: "image", role: "cover", order: 0 });

  const read: SiteRead = {
    status: body.length >= ADEQUATE_BODY_CHARS ? "ok" : "partial",
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    ...(meta.siteName ? { siteName: meta.siteName } : {}),
    ...(meta.published ? { publishedAt: meta.published } : {}),
    ...(body ? { text: body } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(media.length ? { media } : {}),
  };
  if (!read.title && !read.text && !read.media) {
    // Nothing at all came back: a page that only exists once a browser runs it.
    return siteBlocked(
      "unsupported",
      "open_in_my_browser",
      "the page shows nothing until a browser runs it"
    );
  }
  return read;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

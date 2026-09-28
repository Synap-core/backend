/**
 * Read one public http(s) URL into title, author, text, and one image.
 *
 * Official oEmbed (no API key) for YouTube, TikTok, and X/Twitter; otherwise
 * the page's Open Graph tags. Outbound fetches go through `validateExternalUrl`
 * + `safeExternalFetch` — the same SSRF guard as the jobs fetch step. No
 * cookies, no screenshots. A failure is `unavailable`, never a throw.
 */

import {
  safeExternalFetch,
  validateExternalUrl,
  type ValidateUrlResult,
} from "@synap/shared-utils";

const TIMEOUT_MS = 8_000;
/** Public pages redirect (http→https, short links). No credentials are sent. */
const REDIRECT_HOPS = 3;
const HTML_CAP = 256_000;
const TEXT_CAP = 2_000;

const FETCH_HEADERS: Record<string, string> = {
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1",
  "User-Agent": "SynapPublicReader/1.0",
};

export type PublicUrlRead =
  | { kind: "skip" }
  | { kind: "unavailable"; sourceUrl: string }
  | {
      kind: "read";
      title: string;
      author: string | null;
      text: string;
      imageUrl: string | null;
      sourceUrl: string;
    };

/** Additive field on `capture.structure`. Absent when the text is not a lone URL,
 *  or when the installed-verb lookup failed (that is not "nothing installed"). */
export type CaptureUrlReader =
  | {
      status: "enriched";
      title: string;
      author: string | null;
      text: string;
      imageUrl: string | null;
      sourceUrl: string;
    }
  | { status: "unavailable"; sourceUrl: string }
  | { status: "install"; installSlug: "web.read"; sourceUrl: string };

export type PublicUrlFetcher = (
  url: string,
  init?: RequestInit,
  maxRedirects?: number
) => Promise<Response>;

export interface ReadPublicUrlDeps {
  fetch?: PublicUrlFetcher;
  validate?: (raw: string) => ValidateUrlResult;
}

/** The whole trimmed string is one http(s) URL — no surrounding prose. */
export function lonePublicHttpUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return trimmed;
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/** Public oEmbed endpoint for the known hosts, or null. No API key. */
export function oembedEndpoint(pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  const host = bareHost(url.hostname);
  const encoded = encodeURIComponent(url.toString());
  if (host === "youtube.com" || host === "youtu.be") {
    return `https://www.youtube.com/oembed?format=json&url=${encoded}`;
  }
  if (host === "tiktok.com") {
    return `https://www.tiktok.com/oembed?url=${encoded}`;
  }
  if (host === "twitter.com" || host === "x.com") {
    return `https://publish.twitter.com/oembed?url=${encoded}`;
  }
  return null;
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (all, n) => {
      const code = Number(n);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/&#x([0-9a-f]+);/gi, (all, n) => {
      const code = Number.parseInt(n, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : all;
    });
}

function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_CAP);
}

function metaAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag))) {
    const key = match[1]!.toLowerCase();
    attrs[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function metaContent(html: string, key: string): string | null {
  const re = /<meta\b[^>]*>/gi;
  const want = key.toLowerCase();
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const attrs = metaAttrs(match[0]);
    const name = (attrs.property ?? attrs.name ?? "").toLowerCase();
    const content = attrs.content?.trim();
    if (name === want && content) return content;
  }
  return null;
}

function httpUrl(raw: string | null, base: string): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function unreadable(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("image/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("video/") ||
    ct.includes("application/pdf")
  );
}

async function readCapped(res: Response, maxChars: number): Promise<string> {
  if (!res.body) {
    return (await res.text()).slice(0, maxChars);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The body may already be closed.
    }
  }
  return out.slice(0, maxChars);
}

async function guardedGet(
  rawUrl: string,
  validate: (raw: string) => ValidateUrlResult,
  fetchImpl: PublicUrlFetcher
): Promise<{ body: string; contentType: string } | null> {
  const check = validate(rawUrl);
  if (!check.valid) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      rawUrl,
      {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: FETCH_HEADERS,
      },
      REDIRECT_HOPS
    );
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (unreadable(contentType)) return null;
    const body = await readCapped(res, HTML_CAP);
    return { body, contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mapOembed(body: string, sourceUrl: string): PublicUrlRead | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  const title = typeof rec.title === "string" ? rec.title.trim() : "";
  const authorRaw =
    typeof rec.author_name === "string" ? rec.author_name.trim() : "";
  const text = typeof rec.html === "string" ? htmlToText(rec.html) : "";
  const imageUrl = httpUrl(
    typeof rec.thumbnail_url === "string" ? rec.thumbnail_url : null,
    sourceUrl
  );
  if (!title && !text) return null;
  return {
    kind: "read",
    title,
    author: authorRaw || null,
    text,
    imageUrl,
    sourceUrl,
  };
}

function mapHtml(body: string, sourceUrl: string): PublicUrlRead | null {
  const ogTitle = metaContent(body, "og:title");
  let title = ogTitle ?? "";
  if (!title) {
    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
    title = titleTag
      ? decodeEntities(titleTag[1] ?? "")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  }
  const text =
    metaContent(body, "og:description") ??
    metaContent(body, "description") ??
    htmlToText(body);
  const author = metaContent(body, "author");
  const imageUrl = httpUrl(metaContent(body, "og:image"), sourceUrl);
  const capped = text.trim().slice(0, TEXT_CAP);
  if (!title && !capped) return null;
  return {
    kind: "read",
    title,
    author,
    text: capped,
    imageUrl,
    sourceUrl,
  };
}

/**
 * Read `input` when it is exactly one public http(s) URL.
 * Inject `fetch` / `validate` in tests — the defaults are the SSRF helpers.
 */
export async function readPublicUrl(
  input: string,
  deps?: ReadPublicUrlDeps
): Promise<PublicUrlRead> {
  const sourceUrl = lonePublicHttpUrl(input);
  if (!sourceUrl) return { kind: "skip" };

  const validate = deps?.validate ?? validateExternalUrl;
  const fetchImpl = deps?.fetch ?? safeExternalFetch;

  // Refuse before building an oEmbed URL, so a private address is never
  // forwarded as a query parameter to YouTube/TikTok/X.
  if (!validate(sourceUrl).valid) {
    return { kind: "unavailable", sourceUrl };
  }

  const oembed = oembedEndpoint(sourceUrl);
  if (oembed) {
    const got = await guardedGet(oembed, validate, fetchImpl);
    const mapped = got ? mapOembed(got.body, sourceUrl) : null;
    if (mapped) return mapped;
  }

  const page = await guardedGet(sourceUrl, validate, fetchImpl);
  if (!page) return { kind: "unavailable", sourceUrl };
  return mapHtml(page.body, sourceUrl) ?? { kind: "unavailable", sourceUrl };
}

/**
 * Capture's additive reader. A lone URL with no installed `fetch_record` or
 * `capture_into_pod` verb is an install invite — the URL is still captured by
 * the caller. A verb that IS installed still uses this in-process reader
 * (the marketplace template may not be on the pod yet). A lookup failure
 * omits the field; it is not "nothing installed".
 */
export async function readInstalledPublicUrl(opts: {
  text: string;
  userId: string;
  workspaceId: string | null;
  onLookupError?: (err: unknown) => void;
}): Promise<CaptureUrlReader | undefined> {
  const sourceUrl = lonePublicHttpUrl(opts.text);
  if (!sourceUrl) return undefined;

  let installed: boolean;
  try {
    const { capabilitiesByIntent } =
      await import("./capability-intent-index.js");
    const ctx = { userId: opts.userId, workspaceId: opts.workspaceId };
    const [fetchRecord, captureIntoPod] = await Promise.all([
      capabilitiesByIntent(ctx, "fetch_record"),
      capabilitiesByIntent(ctx, "capture_into_pod"),
    ]);
    installed = fetchRecord.length > 0 || captureIntoPod.length > 0;
  } catch (err) {
    opts.onLookupError?.(err);
    return undefined;
  }

  if (!installed) {
    return { status: "install", installSlug: "web.read", sourceUrl };
  }

  try {
    const read = await readPublicUrl(sourceUrl);
    if (read.kind === "skip") return undefined;
    if (read.kind === "unavailable") {
      return { status: "unavailable", sourceUrl: read.sourceUrl };
    }
    if (!read.title.trim() && !read.text.trim()) {
      return { status: "unavailable", sourceUrl: read.sourceUrl };
    }
    return {
      status: "enriched",
      title: read.title,
      author: read.author,
      text: read.text,
      imageUrl: read.imageUrl,
      sourceUrl: read.sourceUrl,
    };
  } catch {
    return { status: "unavailable", sourceUrl };
  }
}

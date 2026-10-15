/**
 * `readBuiltin` — the pod's FREE, in-process reader ladder (the "builtin"
 * rung of the one `readUrl` door):
 *
 *   1. the most specific SITE ADAPTER that declares the URL (official/public
 *      endpoints, logged out);
 *   2. else (or when the adapter declined / failed) the page itself, fetched
 *      through the SSRF door and run through article extraction —
 *      EXCEPT a host the pod never fetches (Instagram, TikTok: P1);
 *   3. an honest `blocked` / `failed` read otherwise — never an empty `ok`.
 *
 * Every result goes through `normalizeUrlRead` (the one parse door) with a
 * `builtin:*` stamp: `builtin:adapter:<id>`, `builtin:article` (the pod
 * fetched the page), `builtin:page` (the page the person's browser sent),
 * `builtin:policy` (refused before any request). Never throws.
 */

import {
  normalizeUrlRead,
  type ReaderStamp,
  type UrlRead,
} from "@synap-core/types/url-read";
import { validateExternalUrl } from "@synap/shared-utils";
import {
  fromGetFailure,
  siteBlocked,
  type SiteAdapter,
  type SiteAdapterContext,
  type SiteRead,
} from "./adapter.js";
import { extractFromHtml } from "./extract.js";
import { WEB_READ_PAGE_BYTES_MAX, webGet, type WebFetcher } from "./fetch.js";
import { findSiteAdapter, podNeverFetches } from "./registry.js";
import { BUILTIN_READ_TEXT_MAX, ADEQUATE_BODY_CHARS } from "./limits.js";

export interface ReadBuiltinOptions {
  /** Inject a recorded-response fake in tests. Default: `safePublicFetch`. */
  fetch?: WebFetcher;
  /** Default: `new Date()`. */
  now?: () => Date;
  signal?: AbortSignal;
  /** Override the adapter table (tests). Default: `SITE_ADAPTERS`. */
  adapters?: readonly SiteAdapter[];
}

/** Display names of the built-in rungs. */
const RUNG_NAME = {
  article: "Synap page reader",
  page: "Your browser's page",
  policy: "Synap reader",
} as const;

export function builtinStamp(
  rung: "article" | "page" | "policy" | { adapter: SiteAdapter },
  now: Date = new Date()
): ReaderStamp {
  const readAt = now.toISOString();
  if (typeof rung === "object") {
    return {
      id: `builtin:adapter:${rung.adapter.id}`,
      name: rung.adapter.name,
      billed: false,
      readAt,
    };
  }
  return {
    id: `builtin:${rung}`,
    name: RUNG_NAME[rung],
    billed: false,
    readAt,
  };
}

/** The lone http(s) URL in `input`, or null. */
function httpUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:" ? trimmed : null;
  } catch {
    return null; // not a URL
  }
}

const READABLE_TEXT_TYPES = /^(text\/plain|text\/markdown|text\/x-markdown)\b/i;
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)\b/i;

/** The page itself: fetch through the SSRF door, then extract. */
async function readPage(
  url: string,
  ctx: SiteAdapterContext
): Promise<SiteRead> {
  const got = await ctx.get(url, {
    accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5,*/*;q=0.1",
    maxBytes: WEB_READ_PAGE_BYTES_MAX,
  });
  if (!got.ok) return fromGetFailure(got, "the page");
  const ct = got.contentType.trim();
  if (!ct || HTML_TYPES.test(ct)) return extractFromHtml(got.body, url);
  if (READABLE_TEXT_TYPES.test(ct)) {
    const text = got.body.trim().slice(0, BUILTIN_READ_TEXT_MAX);
    if (!text) return siteBlocked("not_found", undefined, "the file is empty");
    return {
      status: text.length >= ADEQUATE_BODY_CHARS ? "ok" : "partial",
      text,
    };
  }
  // A PDF, an image, a video, audio, an archive: the page reader does not
  // read files — the person attaches it and the file reader does.
  return siteBlocked(
    "unsupported",
    "attach_file",
    `the link is a file (${ct.split(";")[0]}), not a page`
  );
}

function safeRead(
  adapter: SiteAdapter,
  url: string,
  ctx: SiteAdapterContext
): Promise<SiteRead | null> {
  return adapter.read(url, ctx).catch((err: unknown): SiteRead => ({
    status: "failed",
    error: `${adapter.name} reader crashed: ${err instanceof Error ? err.message : String(err)}`,
  }));
}

/** Read one URL with the pod's free built-in ladder. Never throws. */
export async function readBuiltin(
  input: string,
  opts: ReadBuiltinOptions = {}
): Promise<UrlRead> {
  const now = (opts.now ?? (() => new Date()))();
  const url = httpUrl(input);
  const sourceUrl = url ?? input.trim();
  if (!url) {
    return normalizeUrlRead(
      { status: "failed", error: "not an http(s) URL" },
      sourceUrl,
      builtinStamp("policy", now)
    );
  }
  // Refuse before ANY request — a private address is never sent anywhere,
  // not even as a parameter to a public API.
  const guard = validateExternalUrl(url);
  if (!guard.valid) {
    return normalizeUrlRead(
      siteBlocked(
        "unsupported",
        undefined,
        `not a public web address (${guard.reason})`
      ),
      sourceUrl,
      builtinStamp("policy", now)
    );
  }

  const ctx: SiteAdapterContext = {
    get: (u, o) => webGet(u, o, { fetch: opts.fetch, signal: opts.signal }),
  };

  const adapter = findSiteAdapter(url, opts.adapters);
  let adapterFailure: { read: SiteRead; adapter: SiteAdapter } | null = null;
  if (adapter) {
    const r = await safeRead(adapter, url, ctx);
    if (r && r.status !== "failed") {
      return normalizeUrlRead(r, sourceUrl, builtinStamp({ adapter }, now));
    }
    if (r) adapterFailure = { read: r, adapter };
  }

  if (podNeverFetches(url)) {
    return normalizeUrlRead(
      siteBlocked(
        "needs_reader",
        "install_reader",
        "the pod does not open this site's pages itself; a reader you install can"
      ),
      sourceUrl,
      builtinStamp("policy", now)
    );
  }

  const page = await readPage(url, ctx);
  if (adapterFailure && page.status !== "ok" && page.status !== "partial") {
    // The site's own API failed and the page did not read either: the
    // adapter's failure is the more precise account.
    return normalizeUrlRead(
      adapterFailure.read,
      sourceUrl,
      builtinStamp({ adapter: adapterFailure.adapter }, now)
    );
  }
  return normalizeUrlRead(page, sourceUrl, builtinStamp("article", now));
}

/**
 * The page the person's own browser sent (rendered, possibly signed in),
 * extracted with the same rules and stamped `builtin:page`. No request.
 */
export function readSentPage(
  html: string,
  sourceUrl: string,
  now: Date = new Date()
): UrlRead {
  return normalizeUrlRead(
    extractFromHtml(html, sourceUrl),
    sourceUrl,
    builtinStamp("page", now)
  );
}

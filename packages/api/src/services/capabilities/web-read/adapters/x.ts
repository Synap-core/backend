/**
 * X / Twitter posts. Two public, keyless endpoints, both asked at once:
 *  - the official oEmbed (publish.twitter.com) — author + the post's text as
 *    X itself renders it in an embed;
 *  - the FixTweet public API (api.fxtwitter.com) — the full text, the date,
 *    the counts and the media (photos and mp4 videos).
 * Either alone is a usable read; both failing is an honest failure.
 */

import type { UrlReadMedia } from "@synap-core/types/url-read";
import {
  fromGetFailure,
  isRecord,
  num,
  siteBlocked,
  str,
  type SiteAdapter,
  type SiteAdapterContext,
  type SiteRead,
} from "../adapter.js";
import { parseJson, type WebGetResult } from "../fetch.js";
import { decodeEntities, fragmentText, httpUrlOrNull } from "../html.js";
import { BUILTIN_READ_TEXT_MAX } from "../limits.js";

const xOembed = (url: URL) =>
  `https://publish.twitter.com/oembed?url=${encodeURIComponent(url.toString())}&omit_script=1&dnt=true`;

/** `/<screen>/status/<id>` or `/i/web/status/<id>`. */
function statusOf(url: string): { screen: string; id: string } | null {
  const m = /^\/([^/]+)\/(?:web\/)?status(?:es)?\/(\d+)/.exec(
    new URL(url).pathname
  );
  return m ? { screen: m[1]!, id: m[2]! } : null;
}

interface Part {
  text?: string;
  author?: string;
  authorUrl?: string;
  publishedAt?: string;
  canonicalUrl?: string;
  media?: UrlReadMedia[];
  fields?: Record<string, number>;
}

function fromOembed(got: WebGetResult): Part | null {
  if (!got.ok) return null;
  const rec = parseJson(got.body);
  if (!isRecord(rec)) return null;
  const html = str(rec.html) ?? "";
  const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1];
  const text = p ? fragmentText(p, BUILTIN_READ_TEXT_MAX) : undefined;
  const author = str(rec.author_name);
  const authorUrl = httpUrlOrNull(str(rec.author_url)) ?? undefined;
  const canonicalUrl = httpUrlOrNull(str(rec.url)) ?? undefined;
  if (!text && !author) return null;
  return { text, author, authorUrl, canonicalUrl };
}

function fromFx(got: WebGetResult): Part | null {
  if (!got.ok) return null;
  const rec = parseJson(got.body);
  if (!isRecord(rec) || !isRecord(rec.tweet)) return null;
  const t = rec.tweet;
  const author = isRecord(t.author) ? t.author : {};
  const media: UrlReadMedia[] = [];
  const all =
    isRecord(t.media) && Array.isArray(t.media.all) ? t.media.all : [];
  for (const m of all) {
    if (!isRecord(m)) continue;
    const url = httpUrlOrNull(str(m.url));
    if (!url) continue;
    const width = num(m.width);
    const height = num(m.height);
    const size = {
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    };
    if (m.type === "photo") {
      media.push({ url, kind: "image", order: media.length, ...size });
    } else if (m.type === "video" || m.type === "gif") {
      const thumb = httpUrlOrNull(str(m.thumbnail_url));
      if (thumb && media.length === 0) {
        media.push({
          url: thumb,
          kind: "image",
          role: "cover",
          order: 0,
          ...size,
        });
      }
      const durationSec = num(m.duration);
      media.push({
        url,
        kind: "video",
        order: media.length,
        ...size,
        ...(durationSec ? { durationSec } : {}),
      });
    }
  }
  if (media.length > 1) {
    for (const m of media) if (!m.role) m.role = "slide";
  }
  const ts = num(t.created_timestamp);
  const fields: Record<string, number> = {};
  for (const [from, to] of [
    ["likes", "likes"],
    ["retweets", "reposts"],
    ["replies", "replies"],
    ["views", "views"],
  ] as const) {
    const n = num(t[from]);
    if (n !== undefined) fields[to] = n;
  }
  const screen = str(author.screen_name);
  const text = str(t.text);
  return {
    text: text
      ? decodeEntities(text).slice(0, BUILTIN_READ_TEXT_MAX)
      : undefined,
    author: str(author.name) ?? screen,
    authorUrl:
      httpUrlOrNull(str(author.url)) ??
      (screen ? `https://x.com/${encodeURIComponent(screen)}` : undefined),
    publishedAt: ts ? new Date(ts * 1000).toISOString() : str(t.created_at),
    canonicalUrl: httpUrlOrNull(str(t.url)) ?? undefined,
    media,
    fields,
  };
}

function status(got: WebGetResult): number | null {
  return !got.ok && got.kind === "http" ? got.status : null;
}

async function readX(
  url: string,
  ctx: SiteAdapterContext
): Promise<SiteRead | null> {
  const s = statusOf(url);
  if (!s) return null;
  const [oembedGot, fxGot] = await Promise.all([
    ctx.get(xOembed(new URL(url)), { accept: "application/json" }),
    ctx.get(
      `https://api.fxtwitter.com/${encodeURIComponent(s.screen)}/status/${s.id}`,
      { accept: "application/json" }
    ),
  ]);
  const oe = fromOembed(oembedGot);
  const fx = fromFx(fxGot);

  if (!oe && !fx) {
    const codes = [status(oembedGot), status(fxGot)];
    if (codes.every((c) => c === 404)) {
      return siteBlocked("not_found", undefined, "X has no such post");
    }
    if (codes.some((c) => c === 401 || c === 403)) {
      return siteBlocked(
        "private",
        "open_in_my_browser",
        "the post is protected or not public"
      );
    }
    return fromGetFailure(
      !oembedGot.ok
        ? oembedGot
        : (fxGot as Extract<WebGetResult, { ok: false }>),
      "X"
    );
  }
  const text = [fx?.text, oe?.text]
    .filter((t): t is string => !!t)
    .sort((a, b) => b.length - a.length)[0];
  const media = fx?.media ?? [];
  return {
    // Without the FixTweet answer the media (if any) are unknown.
    status: fx && text ? "ok" : "partial",
    siteName: "X",
    ...(text ? { text } : {}),
    ...((fx?.author ?? oe?.author) ? { author: fx?.author ?? oe?.author } : {}),
    ...((fx?.authorUrl ?? oe?.authorUrl)
      ? { authorUrl: fx?.authorUrl ?? oe?.authorUrl }
      : {}),
    ...(fx?.publishedAt ? { publishedAt: fx.publishedAt } : {}),
    ...((fx?.canonicalUrl ?? oe?.canonicalUrl)
      ? { canonicalUrl: fx?.canonicalUrl ?? oe?.canonicalUrl }
      : {}),
    ...(media.length ? { media } : {}),
    ...(fx?.fields && Object.keys(fx.fields).length
      ? { fields: fx.fields }
      : {}),
  };
}

export const xAdapter: SiteAdapter = {
  id: "x",
  name: "X",
  serviceId: "x",
  urls: [
    "*.x.com/*/status/*",
    "*.twitter.com/*/status/*",
    "*.x.com/i/web/status/*",
    "*.twitter.com/i/web/status/*",
  ],
  oembed: xOembed,
  read: readX,
};

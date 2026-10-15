/**
 * Video hosts read through their official, keyless oEmbed endpoints:
 * YouTube, TikTok and Vimeo. oEmbed gives the title, the author and a
 * thumbnail — never the video, the description (except Vimeo) or a
 * transcript — so a read is `partial` unless real text came back.
 *
 * TikTok: oEmbed is the ONLY TikTok request the pod makes (P1: the pod never
 * fetches a TikTok or Instagram page itself).
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
import { parseJson } from "../fetch.js";
import { fragmentText, httpUrlOrNull } from "../html.js";
import { BUILTIN_READ_TEXT_MAX } from "../limits.js";

const enc = (url: URL) => encodeURIComponent(url.toString());

/**
 * GET an oEmbed endpoint and map the common fields. 404 → `null`: the URL
 * matched a pattern but the provider does not know it as a video (a channel
 * page, a deleted video) — the page decides. 401/403 → the provider refuses
 * to describe it (private or not embeddable).
 */
export async function readOembed(
  endpoint: string,
  ctx: SiteAdapterContext,
  provider: string
): Promise<{ rec: Record<string, unknown>; base: SiteRead } | SiteRead | null> {
  const got = await ctx.get(endpoint, { accept: "application/json" });
  if (!got.ok) {
    if (got.kind === "http" && (got.status === 404 || got.status === 400)) {
      return null;
    }
    if (got.kind === "http" && (got.status === 401 || got.status === 403)) {
      return siteBlocked(
        "private",
        "open_in_my_browser",
        `${provider} does not describe this video publicly (HTTP ${got.status})`
      );
    }
    return fromGetFailure(got, `${provider}'s oEmbed endpoint`);
  }
  const rec = parseJson(got.body);
  if (!isRecord(rec)) {
    return { status: "failed", error: `${provider} oEmbed answered no JSON` };
  }
  const media: UrlReadMedia[] = [];
  const thumb = httpUrlOrNull(str(rec.thumbnail_url));
  if (thumb) {
    const w = num(rec.thumbnail_width);
    const h = num(rec.thumbnail_height);
    media.push({
      url: thumb,
      kind: "image",
      role: "cover",
      order: 0,
      ...(w ? { width: w } : {}),
      ...(h ? { height: h } : {}),
    });
  }
  const author = str(rec.author_name);
  const authorUrl = httpUrlOrNull(str(rec.author_url));
  const base: SiteRead = {
    status: "partial",
    siteName: str(rec.provider_name) ?? provider,
    ...(str(rec.title) ? { title: str(rec.title) } : {}),
    ...(author ? { author } : {}),
    ...(authorUrl ? { authorUrl } : {}),
    ...(media.length ? { media } : {}),
  };
  return { rec, base };
}

function isMapped(
  r: Awaited<ReturnType<typeof readOembed>>
): r is { rec: Record<string, unknown>; base: SiteRead } {
  return r !== null && "rec" in r;
}

const youtubeOembed = (url: URL) =>
  `https://www.youtube.com/oembed?format=json&url=${enc(url)}`;

export const youtubeAdapter: SiteAdapter = {
  id: "youtube",
  name: "YouTube",
  serviceId: "youtube",
  urls: [
    "*.youtube.com/watch",
    "*.youtube.com/shorts/*",
    "*.youtube.com/live/*",
    "*.youtube.com/playlist",
    "youtu.be/*",
  ],
  oembed: youtubeOembed,
  async read(url, ctx) {
    const r = await readOembed(youtubeOembed(new URL(url)), ctx, "YouTube");
    if (!isMapped(r)) return r;
    // oEmbed carries no description and no transcript: partial by design.
    return r.base;
  },
};

const tiktokOembed = (url: URL) =>
  `https://www.tiktok.com/oembed?url=${enc(url)}`;

export const tiktokAdapter: SiteAdapter = {
  id: "tiktok",
  name: "TikTok",
  serviceId: "tiktok",
  urls: [
    "*.tiktok.com/@*/video/*",
    "*.tiktok.com/@*/photo/*",
    "vm.tiktok.com/*",
    "vt.tiktok.com/*",
  ],
  oembed: tiktokOembed,
  async read(url, ctx) {
    const r = await readOembed(tiktokOembed(new URL(url)), ctx, "TikTok");
    if (r === null) {
      // The pod never fetches the TikTok page itself (P1): a reader the
      // person installs can.
      return siteBlocked(
        "needs_reader",
        "install_reader",
        "TikTok's public oEmbed does not describe this link"
      );
    }
    if (!isMapped(r)) return r;
    // TikTok's oEmbed `title` IS the caption: keep it as the text too. Still
    // partial — no video, no slides, no counts.
    const caption = str(r.rec.title);
    return { ...r.base, ...(caption ? { text: caption } : {}) };
  },
};

const vimeoOembed = (url: URL) =>
  `https://vimeo.com/api/oembed.json?url=${enc(url)}`;

export const vimeoAdapter: SiteAdapter = {
  id: "vimeo",
  name: "Vimeo",
  urls: ["vimeo.com/*", "player.vimeo.com/video/*"],
  oembed: vimeoOembed,
  async read(url, ctx) {
    const r = await readOembed(vimeoOembed(new URL(url)), ctx, "Vimeo");
    if (!isMapped(r)) return r;
    const description = str(r.rec.description);
    const text = description
      ? fragmentText(description, BUILTIN_READ_TEXT_MAX)
      : "";
    // Vimeo's upload_date is "YYYY-MM-DD hh:mm:ss" with no zone: keep the day.
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(str(r.rec.upload_date) ?? "")?.[1];
    const duration = num(r.rec.duration);
    const videoId = num(r.rec.video_id);
    return {
      ...r.base,
      status: text ? "ok" : "partial",
      ...(text ? { text } : {}),
      ...(day ? { publishedAt: day } : {}),
      ...(duration || videoId
        ? {
            fields: {
              ...(duration ? { durationSec: duration } : {}),
              ...(videoId ? { videoId } : {}),
            },
          }
        : {}),
    };
  },
};

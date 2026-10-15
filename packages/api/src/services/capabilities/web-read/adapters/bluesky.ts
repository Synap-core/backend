/**
 * Bluesky posts through the public AppView (public.api.bsky.app), keyless:
 * `com.atproto.identity.resolveHandle` (when the URL names a handle) then
 * `app.bsky.feed.getPostThread` at depth 0. An author who asked logged-out
 * viewers not to see their posts (`!no-unauthenticated`) is respected: that
 * read is a login wall, not data.
 */

import type { UrlReadMedia } from "@synap-core/types/url-read";
import {
  fromGetFailure,
  isRecord,
  num,
  siteBlocked,
  str,
  type SiteAdapter,
  type SiteRead,
} from "../adapter.js";
import { parseJson } from "../fetch.js";
import { httpUrlOrNull } from "../html.js";

const APPVIEW = "https://public.api.bsky.app/xrpc";

function size(v: unknown): { width?: number; height?: number } {
  if (!isRecord(v)) return {};
  const width = num(v.width);
  const height = num(v.height);
  return { ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

/** Media of an embed view (images, video thumbnail, link card, or with-record). */
function embedMedia(
  embed: unknown,
  out: UrlReadMedia[],
  fields: Record<string, string>
) {
  if (!isRecord(embed)) return;
  const type = str(embed.$type) ?? "";
  if (type.startsWith("app.bsky.embed.images")) {
    const images = Array.isArray(embed.images) ? embed.images : [];
    for (const img of images) {
      if (!isRecord(img)) continue;
      const url = httpUrlOrNull(str(img.fullsize) ?? str(img.thumb));
      if (url) {
        out.push({
          url,
          kind: "image",
          order: out.length,
          ...size(img.aspectRatio),
        });
      }
    }
  } else if (type.startsWith("app.bsky.embed.video")) {
    // The video itself is an HLS playlist, not a file the pod can keep:
    // only its thumbnail is media here.
    const thumb = httpUrlOrNull(str(embed.thumbnail));
    if (thumb) {
      out.push({
        url: thumb,
        kind: "image",
        role: "cover",
        order: out.length,
        ...size(embed.aspectRatio),
      });
    }
  } else if (type.startsWith("app.bsky.embed.external")) {
    const ext = isRecord(embed.external) ? embed.external : {};
    const link = httpUrlOrNull(str(ext.uri));
    if (link) fields.linkUrl = link;
    const thumb = httpUrlOrNull(str(ext.thumb));
    if (thumb)
      out.push({ url: thumb, kind: "image", role: "cover", order: out.length });
  } else if (type.startsWith("app.bsky.embed.recordWithMedia")) {
    embedMedia(embed.media, out, fields);
  }
}

export const blueskyAdapter: SiteAdapter = {
  id: "bluesky",
  name: "Bluesky",
  urls: ["bsky.app/profile/*/post/*"],
  async read(url, ctx): Promise<SiteRead | null> {
    const m = /^\/profile\/([^/]+)\/post\/([^/]+)/.exec(new URL(url).pathname);
    if (!m) return null;
    let actor = decodeURIComponent(m[1]!);
    const rkey = m[2]!;

    if (!actor.startsWith("did:")) {
      const got = await ctx.get(
        `${APPVIEW}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`,
        { accept: "application/json" }
      );
      if (!got.ok) {
        if (got.kind === "http" && got.status === 400) {
          return siteBlocked(
            "not_found",
            undefined,
            `no Bluesky account @${actor}`
          );
        }
        return fromGetFailure(got, "Bluesky");
      }
      const did = str(
        (parseJson(got.body) as Record<string, unknown> | null)?.did
      );
      if (!did)
        return {
          status: "failed",
          error: "Bluesky did not resolve the handle",
        };
      actor = did;
    }

    const uri = `at://${actor}/app.bsky.feed.post/${rkey}`;
    const got = await ctx.get(
      `${APPVIEW}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=0`,
      { accept: "application/json" }
    );
    if (!got.ok) {
      if (
        got.kind === "http" &&
        got.status === 400 &&
        /NotFound/i.test(got.body)
      ) {
        return siteBlocked("not_found", undefined, "Bluesky has no such post");
      }
      return fromGetFailure(got, "Bluesky");
    }
    const body = parseJson(got.body);
    const thread = isRecord(body) && isRecord(body.thread) ? body.thread : null;
    if (!thread)
      return { status: "failed", error: "Bluesky answered no thread" };
    const ttype = str(thread.$type) ?? "";
    if (ttype.endsWith("#notFoundPost")) {
      return siteBlocked("not_found", undefined, "Bluesky has no such post");
    }
    if (ttype.endsWith("#blockedPost")) {
      return siteBlocked(
        "private",
        "open_in_my_browser",
        "the post is blocked"
      );
    }
    const post = isRecord(thread.post) ? thread.post : null;
    if (!post) return { status: "failed", error: "Bluesky answered no post" };

    const author = isRecord(post.author) ? post.author : {};
    const labels = Array.isArray(author.labels) ? author.labels : [];
    if (labels.some((l) => isRecord(l) && l.val === "!no-unauthenticated")) {
      return siteBlocked(
        "login_wall",
        "open_in_my_browser",
        "the author shows their posts to signed-in people only"
      );
    }
    const record = isRecord(post.record) ? post.record : {};
    const handle = str(author.handle);
    const media: UrlReadMedia[] = [];
    const fields: Record<string, string | number> = {};
    const linkFields: Record<string, string> = {};
    embedMedia(post.embed, media, linkFields);
    Object.assign(fields, linkFields);
    for (const k of ["likeCount", "repostCount", "replyCount", "quoteCount"]) {
      const n = num(post[k]);
      if (n !== undefined) fields[k.replace(/Count$/, "s")] = n;
    }
    if (media.length > 1) for (const x of media) if (!x.role) x.role = "slide";
    const text = str(record.text);
    return {
      status: text || media.length ? "ok" : "partial",
      siteName: "Bluesky",
      ...(text ? { text } : {}),
      ...((str(author.displayName) ?? handle)
        ? { author: str(author.displayName) ?? handle }
        : {}),
      ...(handle ? { authorUrl: `https://bsky.app/profile/${handle}` } : {}),
      ...(str(record.createdAt) ? { publishedAt: str(record.createdAt) } : {}),
      canonicalUrl: `https://bsky.app/profile/${handle ?? actor}/post/${rkey}`,
      ...(media.length ? { media } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
    };
  },
};

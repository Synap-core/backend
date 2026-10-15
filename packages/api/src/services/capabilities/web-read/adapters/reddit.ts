/**
 * Reddit threads through the thread's public Atom feed (`<thread>/.rss`):
 * Reddit refuses `.json` to unauthenticated servers, the feed is still served.
 * The post is the `t3_` entry, the comments are the `t1_` entries after it.
 * Reddit often refuses datacenter IPs outright (403): that is an honest
 * `blocked`, and the person's own browser is the next step.
 */

import type { UrlReadMedia } from "@synap-core/types/url-read";
import {
  fromGetFailure,
  siteBlocked,
  type SiteAdapter,
  type SiteRead,
} from "../adapter.js";
import { decodeEntities, fragmentText, httpUrlOrNull } from "../html.js";
import { BUILTIN_READ_TEXT_MAX, DISCUSSION_COMMENTS_MAX } from "../limits.js";

function inner(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(
    xml
  );
  return m ? m[1] : undefined;
}

function plain(xml: string | undefined): string | undefined {
  if (!xml) return undefined;
  const v = decodeEntities(xml).replace(/\s+/g, " ").trim();
  return v || undefined;
}

/** The reading text of one entry's escaped-HTML `<content>`: its `.md` body. */
function entryBody(entry: string, max: number): string {
  const html = decodeEntities(inner(entry, "content") ?? "");
  // A post's body sits between Reddit's SC_OFF / SC_ON markers; a comment's
  // is its one `.md` div. Neither includes the "submitted by … [link]" trailer.
  const md =
    /<!--\s*SC_OFF\s*-->([\s\S]*?)<!--\s*SC_ON\s*-->/i.exec(html)?.[1] ??
    /<div class="md">([\s\S]*)<\/div>/i.exec(html)?.[1];
  return md ? fragmentText(md, max) : "";
}

export const redditAdapter: SiteAdapter = {
  id: "reddit",
  name: "Reddit",
  urls: ["*.reddit.com/r/*/comments/*"],
  async read(url, ctx): Promise<SiteRead | null> {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    if (!/^\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(path)) return null;
    const got = await ctx.get(`https://www.reddit.com${path}/.rss`, {
      accept: "application/atom+xml, application/xml;q=0.9",
    });
    if (!got.ok) return fromGetFailure(got, "Reddit");
    const entries = [
      ...got.body.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
    ].map((m) => m[1]!);
    const post = entries.find((e) => /<id>\s*t3_/i.test(e)) ?? entries[0];
    if (!post) {
      return siteBlocked("not_found", undefined, "Reddit has no such thread");
    }
    const title = plain(inner(post, "title"));
    const authorName = plain(inner(inner(post, "author") ?? "", "name"));
    const author = authorName?.replace(/^\/?u\//, "");
    const authorUrl = httpUrlOrNull(
      plain(inner(inner(post, "author") ?? "", "uri"))
    );
    const published =
      plain(inner(post, "published")) ?? plain(inner(post, "updated"));
    const sub = /<category\b[^>]*term="([^"]+)"/i.exec(post)?.[1];
    const canonical = httpUrlOrNull(
      /<link\b[^>]*href="([^"]+)"/i.exec(post)?.[1]
        ? decodeEntities(/<link\b[^>]*href="([^"]+)"/i.exec(post)![1]!)
        : null
    );
    const contentHtml = decodeEntities(inner(post, "content") ?? "");
    const linkMatch = /<a href="([^"]+)">\[link\]<\/a>/i.exec(contentHtml)?.[1];
    const linkUrl = linkMatch ? httpUrlOrNull(decodeEntities(linkMatch)) : null;
    const thumb = /<media:thumbnail\b[^>]*url="([^"]+)"/i.exec(post)?.[1];
    const media: UrlReadMedia[] = [];
    const thumbUrl = thumb ? httpUrlOrNull(decodeEntities(thumb)) : null;
    if (thumbUrl)
      media.push({ url: thumbUrl, kind: "image", role: "cover", order: 0 });

    const parts: string[] = [];
    const self = entryBody(post, BUILTIN_READ_TEXT_MAX);
    if (self) parts.push(self);
    const comments = entries
      .filter((e) => e !== post && /<id>\s*t1_/i.test(e))
      .slice(0, DISCUSSION_COMMENTS_MAX)
      .map((e) => {
        const who =
          plain(inner(inner(e, "author") ?? "", "name"))?.replace(
            /^\/?u\//,
            ""
          ) ?? "?";
        const body = entryBody(e, 4_000).replace(/\n+/g, " ");
        return body ? `${who}: ${body}` : "";
      })
      .filter(Boolean);
    if (comments.length) parts.push(comments.join("\n\n"));
    const text = parts.join("\n\n").slice(0, BUILTIN_READ_TEXT_MAX);

    return {
      status: self || comments.length ? "ok" : "partial",
      siteName: "Reddit",
      ...(title ? { title } : {}),
      ...(text ? { text } : {}),
      ...(author ? { author } : {}),
      ...(authorUrl ? { authorUrl } : {}),
      ...(published ? { publishedAt: published } : {}),
      ...(canonical ? { canonicalUrl: canonical } : {}),
      ...(media.length ? { media } : {}),
      fields: {
        ...(sub ? { subreddit: sub } : {}),
        ...(linkUrl && linkUrl !== canonical ? { linkUrl } : {}),
        comments: entries.filter((e) => /<id>\s*t1_/i.test(e)).length,
      },
    };
  },
};

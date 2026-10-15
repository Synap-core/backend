/**
 * Hacker News items through the public Algolia HN API (hn.algolia.com), which
 * returns the item with its whole comment tree in one keyless call. A story's
 * text is its own text (Ask/Show HN) plus the first top-level comments — the
 * discussion IS the content of an HN link.
 */

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
import { fragmentText, httpUrlOrNull } from "../html.js";
import { BUILTIN_READ_TEXT_MAX, DISCUSSION_COMMENTS_MAX } from "../limits.js";

function countDescendants(children: unknown): number {
  if (!Array.isArray(children)) return 0;
  return children.reduce<number>(
    (n, c) => n + (isRecord(c) ? 1 + countDescendants(c.children) : 0),
    0
  );
}

export const hackerNewsAdapter: SiteAdapter = {
  id: "hacker-news",
  name: "Hacker News",
  urls: ["news.ycombinator.com/item"],
  async read(url, ctx): Promise<SiteRead | null> {
    const id = new URL(url).searchParams.get("id");
    if (!id || !/^\d+$/.test(id)) return null;
    const got = await ctx.get(`https://hn.algolia.com/api/v1/items/${id}`, {
      accept: "application/json",
    });
    if (!got.ok) return fromGetFailure(got, "Hacker News");
    const item = parseJson(got.body);
    if (!isRecord(item) || num(item.id) === undefined) {
      return { status: "failed", error: "Hacker News answered no item" };
    }
    if (
      item.deleted === true ||
      (!str(item.title) && !str(item.text) && !str(item.author))
    ) {
      return siteBlocked("not_found", undefined, "the item was deleted");
    }
    const parts: string[] = [];
    const own = str(item.text);
    if (own) parts.push(fragmentText(own, BUILTIN_READ_TEXT_MAX));
    const children = Array.isArray(item.children) ? item.children : [];
    const comments = children
      .filter((c): c is Record<string, unknown> => isRecord(c) && !!str(c.text))
      .slice(0, DISCUSSION_COMMENTS_MAX)
      .map(
        (c) =>
          `${str(c.author) ?? "?"}: ${fragmentText(str(c.text)!, 4_000).replace(/\n+/g, " ")}`
      );
    if (comments.length) parts.push(comments.join("\n\n"));
    const text = parts.join("\n\n").slice(0, BUILTIN_READ_TEXT_MAX);

    const author = str(item.author);
    const link = httpUrlOrNull(str(item.url));
    const points = num(item.points);
    const fields: Record<string, string | number> = {
      comments: countDescendants(item.children),
      ...(points !== undefined ? { points } : {}),
      ...(link ? { linkUrl: link } : {}),
      ...(str(item.type) ? { itemType: str(item.type)! } : {}),
    };
    return {
      // A link story with no discussion yet is only its title + link.
      status: text ? "ok" : "partial",
      siteName: "Hacker News",
      ...(str(item.title) ? { title: str(item.title) } : {}),
      ...(text ? { text } : {}),
      ...(author
        ? {
            author,
            authorUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(author)}`,
          }
        : {}),
      ...(str(item.created_at) ? { publishedAt: str(item.created_at) } : {}),
      canonicalUrl: `https://news.ycombinator.com/item?id=${id}`,
      fields,
    };
  },
};

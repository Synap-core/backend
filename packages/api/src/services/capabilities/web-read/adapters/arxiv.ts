/**
 * arXiv papers through the public export API (export.arxiv.org/api/query,
 * Atom). The abstract is the text; the PDF link is a field (a stored PDF is
 * read by the file reader, never re-fetched here).
 */

import {
  fromGetFailure,
  siteBlocked,
  type SiteAdapter,
  type SiteRead,
} from "../adapter.js";
import { decodeEntities } from "../html.js";
import { BUILTIN_READ_TEXT_MAX } from "../limits.js";

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(
    xml
  );
  if (!m) return undefined;
  const v = decodeEntities(m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
    .replace(/\s+/g, " ")
    .trim();
  return v || undefined;
}

/** `2401.01234v2`, `hep-th/9901001` — from /abs/<id> or /pdf/<id>[.pdf]. */
function arxivId(pathname: string): string | null {
  const m = /^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/.exec(pathname);
  if (!m) return null;
  const id = m[1]!;
  return /^([a-z-]+(\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?$/i.test(id)
    ? id
    : null;
}

export const arxivAdapter: SiteAdapter = {
  id: "arxiv",
  name: "arXiv",
  urls: ["arxiv.org/abs/**", "arxiv.org/pdf/**"],
  async read(url, ctx): Promise<SiteRead | null> {
    const id = arxivId(new URL(url).pathname);
    if (!id) return null;
    const got = await ctx.get(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`,
      { accept: "application/atom+xml" }
    );
    if (!got.ok) return fromGetFailure(got, "arXiv");
    const entry = /<entry\b[^>]*>([\s\S]*?)<\/entry>/i.exec(got.body)?.[1];
    const title = entry ? tag(entry, "title") : undefined;
    // An unknown id answers an empty feed, or an entry titled "Error".
    if (!entry || !title || title === "Error") {
      return siteBlocked("not_found", undefined, `arXiv has no paper ${id}`);
    }
    const abstract = tag(entry, "summary");
    const authors = [
      ...entry.matchAll(/<author\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/gi),
    ]
      .map((m) => decodeEntities(m[1]!).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const pdf =
      /<link\b[^>]*title="pdf"[^>]*href="([^"]+)"/i.exec(entry)?.[1] ??
      /<link\b[^>]*href="([^"]+)"[^>]*title="pdf"/i.exec(entry)?.[1];
    const category = /<arxiv:primary_category\b[^>]*term="([^"]+)"/i.exec(
      entry
    )?.[1];
    const published = tag(entry, "published");
    const baseId = id.replace(/v\d+$/, "");
    return {
      status: abstract ? "ok" : "partial",
      siteName: "arXiv",
      title,
      ...(abstract ? { text: abstract.slice(0, BUILTIN_READ_TEXT_MAX) } : {}),
      ...(authors.length ? { author: authors.join(", ") } : {}),
      ...(published ? { publishedAt: published } : {}),
      canonicalUrl: `https://arxiv.org/abs/${baseId}`,
      fields: {
        arxivId: baseId,
        ...(authors.length ? { authors: authors.join(", ") } : {}),
        ...(category ? { primaryCategory: category } : {}),
        ...(pdf ? { pdfUrl: decodeEntities(pdf) } : {}),
      },
    };
  },
};

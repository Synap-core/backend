/**
 * Wikipedia articles, keyless, through Wikimedia's public APIs: the REST
 * page summary (title, short description, lead image, canonical URL) and the
 * TextExtracts plain-text extract of the whole article.
 */

import type { UrlReadMedia } from "@synap-core/types/url-read";
import {
  fromGetFailure,
  isRecord,
  num,
  str,
  type SiteAdapter,
  type SiteRead,
} from "../adapter.js";
import { parseJson } from "../fetch.js";
import { httpUrlOrNull } from "../html.js";
import { BUILTIN_READ_TEXT_MAX } from "../limits.js";

export const wikipediaAdapter: SiteAdapter = {
  id: "wikipedia",
  name: "Wikipedia",
  urls: ["*.wikipedia.org/wiki/*"],
  async read(url, ctx): Promise<SiteRead | null> {
    const u = new URL(url);
    const labels = u.hostname.toLowerCase().split(".");
    const lang = labels[0];
    if (!lang || lang === "www" || !/^[a-z][a-z0-9-]*$/.test(lang)) return null;
    let title: string;
    try {
      title = decodeURIComponent(u.pathname.slice("/wiki/".length));
    } catch {
      return null; // a malformed escape is not an article title
    }
    if (!title || /^(Special|File|Media):/i.test(title)) return null;
    const origin = `https://${lang}.wikipedia.org`;

    const [summaryGot, extractGot] = await Promise.all([
      ctx.get(
        `${origin}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}?redirect=true`,
        { accept: "application/json" }
      ),
      ctx.get(
        `${origin}/w/api.php?action=query&format=json&formatversion=2&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(title.replace(/_/g, " "))}`,
        { accept: "application/json", maxBytes: 2_000_000 }
      ),
    ]);
    if (!summaryGot.ok) {
      // Not an article the API knows (a namespace page, a typo): the page decides.
      if (summaryGot.kind === "http" && summaryGot.status === 404) return null;
      return fromGetFailure(summaryGot, "Wikipedia");
    }
    const s = parseJson(summaryGot.body);
    if (!isRecord(s))
      return { status: "failed", error: "Wikipedia answered no summary" };

    let full: string | undefined;
    if (extractGot.ok) {
      const q = parseJson(extractGot.body);
      const pages =
        isRecord(q) && isRecord(q.query) && Array.isArray(q.query.pages)
          ? q.query.pages
          : [];
      const page = pages.find((p) => isRecord(p) && !p.missing);
      full = isRecord(page) ? str(page.extract) : undefined;
    }
    const text = (full ?? str(s.extract) ?? "").slice(0, BUILTIN_READ_TEXT_MAX);

    const media: UrlReadMedia[] = [];
    const img = isRecord(s.originalimage)
      ? s.originalimage
      : isRecord(s.thumbnail)
        ? s.thumbnail
        : null;
    const imgUrl = img ? httpUrlOrNull(str(img.source)) : null;
    if (img && imgUrl) {
      const width = num(img.width);
      const height = num(img.height);
      media.push({
        url: imgUrl,
        kind: "image",
        role: "cover",
        order: 0,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      });
    }
    const urls =
      isRecord(s.content_urls) && isRecord(s.content_urls.desktop)
        ? s.content_urls.desktop
        : {};
    const canonicalUrl = httpUrlOrNull(str(urls.page));
    const description = str(s.description);
    return {
      // Only the summary's lead paragraph came back: say so.
      status: full ? "ok" : "partial",
      siteName: "Wikipedia",
      ...(str(s.title) ? { title: str(s.title) } : {}),
      ...(text ? { text } : {}),
      ...(canonicalUrl ? { canonicalUrl } : {}),
      ...(media.length ? { media } : {}),
      fields: {
        lang,
        ...(description ? { description } : {}),
        ...(str(s.type) ? { pageType: str(s.type)! } : {}),
      },
    };
  },
};

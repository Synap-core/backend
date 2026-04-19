/**
 * RSSDirectProvider
 *
 * Fetches an RSS/Atom/JSON feed directly over HTTP. No auth, no CP.
 *
 * Config shape: { feedUrl: string, userAgent?: string }.
 *
 * This is a clean-room replacement for the logic previously in
 * packages/jobs/src/fetchers/rss-fetcher.ts — only the DIRECT branch is kept;
 * the CP-proxy branch moved to `CPRelayProvider.ts`.
 *
 * The parser uses a regex-based XML walker (same as the old fetcher) to avoid
 * pulling in a heavy XML library in this package. It handles:
 *   - RSS 2.0 (<item>)
 *   - Atom   (<entry>)
 *   - JSON Feed 1.0/1.1
 *
 * Cursors: the provider honors and emits HTTP ETag / Last-Modified as the
 * opaque `sinceToken`. On unchanged responses (304) it returns an empty item
 * list and echoes the token back.
 */

import { z } from "zod";
import { createLogger } from "@synap-core/core";
import type {
  ISourceProvider,
  ResolvedConfig,
  FetchParams,
  FetchResult,
  SourceItem,
  SourceProviderMeta,
  TestConnectionResult,
} from "./ISourceProvider.js";

const logger = createLogger({ module: "rss-direct-provider" });

// ── Config Schema ────────────────────────────────────────────────────────────

export const RSSDirectConfigSchema = z.object({
  feedUrl: z.string().url(),
  userAgent: z.string().optional(),
});
export type RSSDirectConfig = z.infer<typeof RSSDirectConfigSchema>;

// ── Helpers (ported from jobs/fetchers/rss-fetcher.ts) ───────────────────────

interface ParsedFeedItem {
  id?: string;
  title?: string;
  link?: string;
  description?: string;
  content?: string;
  pubDate?: string;
  author?: string;
  imageUrl?: string;
}

function parseRSSXML(xml: string, feedUrl: string): ParsedFeedItem[] {
  const items: ParsedFeedItem[] = [];
  const itemRegex = /<(item|entry)[^>]*>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[2];

    const getField = (tag: string): string | undefined => {
      const regex = new RegExp(
        `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`,
        ""
      );
      const m = itemXml.match(regex);
      return m?.[1]?.trim();
    };

    const guid = getField("guid") || getField("id");
    const title = getField("title") || "Untitled";
    let link = getField("link") || getField("id");
    const description =
      getField("description") || getField("summary") || getField("content");
    const pubDate =
      getField("pubDate") || getField("published") || getField("updated");
    const author = getField("author") || getField("creator");

    // Atom <link href="..."> fallback
    if (!link || !link.startsWith("http")) {
      const atomLinkMatch = itemXml.match(/<link[^>]*href="([^"]+)"/);
      if (atomLinkMatch) {
        link = atomLinkMatch[1];
      }
    }

    // Crude image extraction: first <img src="..."> in description
    let imageUrl: string | undefined;
    if (description) {
      const imgMatch = description.match(/<img[^>]+src="([^"]+)"/);
      if (imgMatch) imageUrl = imgMatch[1];
    }

    if (guid || link) {
      items.push({
        id: guid || link!,
        title,
        link,
        description,
        content: description,
        pubDate,
        author,
        imageUrl,
      });
    }
  }

  if (items.length === 0) {
    // Log once so operators can diagnose unparseable feeds without flooding.
    logger.debug({ feedUrl }, "RSS XML produced zero items");
  }

  return items;
}

function parseJSONFeed(json: unknown): ParsedFeedItem[] {
  if (!json || typeof json !== "object") return [];
  const feed = json as Record<string, unknown>;
  const items = (feed.items as Array<Record<string, unknown>>) || [];

  return items.map((item) => {
    const authorObj = item.author as Record<string, unknown> | undefined;
    return {
      id:
        (item.id as string | undefined) ||
        (item.url as string | undefined) ||
        (item.external_url as string | undefined),
      title: (item.title as string | undefined) || "Untitled",
      link:
        (item.url as string | undefined) ||
        (item.external_url as string | undefined),
      description:
        (item.summary as string | undefined) ||
        (item.content_text as string | undefined),
      content:
        (item.content_html as string | undefined) ||
        (item.content_text as string | undefined),
      pubDate:
        (item.date_published as string | undefined) ||
        (item.date_modified as string | undefined),
      author: authorObj?.name as string | undefined,
      imageUrl:
        (item.image as string | undefined) ||
        (item.banner_image as string | undefined),
    };
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
}

function safeDate(value: string | undefined): Date {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// ── Provider ─────────────────────────────────────────────────────────────────

const DEFAULT_USER_AGENT = "SynapFeedBot/1.0 (+https://synap.io/bot)";

export class RSSDirectProvider implements ISourceProvider {
  readonly meta: SourceProviderMeta = {
    type: "rss-direct",
    displayName: "RSS / Atom / JSON Feed",
    description:
      "Fetch an RSS 2.0, Atom, or JSON Feed directly over HTTP. No auth required.",
    capabilities: {
      supportsCursor: true, // via ETag / Last-Modified
      supportsTesting: true,
      requiresAuth: false,
    },
    configSchema: RSSDirectConfigSchema,
  };

  async fetch(
    config: ResolvedConfig,
    params: FetchParams
  ): Promise<FetchResult> {
    const { feedUrl, userAgent } = RSSDirectConfigSchema.parse(config);

    const headers: Record<string, string> = {
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json",
      "User-Agent": userAgent || DEFAULT_USER_AGENT,
    };

    // Conditional GET via ETag — if sinceToken looks like an ETag, forward it.
    if (params.sinceToken) {
      if (
        params.sinceToken.startsWith('W/"') ||
        params.sinceToken.startsWith('"')
      ) {
        headers["If-None-Match"] = params.sinceToken;
      } else {
        // Fallback: treat opaque tokens as Last-Modified
        headers["If-Modified-Since"] = params.sinceToken;
      }
    }

    const response = await fetch(feedUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    // 304 Not Modified — nothing new.
    if (response.status === 304) {
      return { items: [], nextToken: params.sinceToken };
    }

    if (!response.ok) {
      throw new Error(
        `RSS fetch failed: ${response.status} ${response.statusText}`
      );
    }

    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();

    const rawItems: ParsedFeedItem[] = contentType.includes("json")
      ? parseJSONFeed(JSON.parse(body))
      : parseRSSXML(body, feedUrl);

    const limit = params.limit ?? rawItems.length;
    const items: SourceItem[] = rawItems.slice(0, limit).map((raw) => {
      const contentHtml = raw.content || raw.description || "";
      const contentText = stripHtml(contentHtml);

      return {
        externalId: raw.id || raw.link || `${feedUrl}#${Date.now()}`,
        title: raw.title || "Untitled",
        url: raw.link || feedUrl,
        excerpt: contentText ? truncate(contentText, 500) : undefined,
        publishedAt: safeDate(raw.pubDate),
        author: raw.author,
        imageUrl: raw.imageUrl,
        raw,
      };
    });

    // Prefer ETag, fall back to Last-Modified.
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    const nextToken = etag || lastModified || params.sinceToken;

    return { items, nextToken: nextToken || undefined };
  }

  async testConnection(config: ResolvedConfig): Promise<TestConnectionResult> {
    const parsed = RSSDirectConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }

    try {
      // Some RSS servers reject HEAD; fall back to a lightweight GET with a
      // short AbortSignal if HEAD returns 4xx/5xx.
      let res = await fetch(parsed.data.feedUrl, {
        method: "HEAD",
        headers: {
          "User-Agent": parsed.data.userAgent || DEFAULT_USER_AGENT,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        res = await fetch(parsed.data.feedUrl, {
          method: "GET",
          headers: {
            "User-Agent": parsed.data.userAgent || DEFAULT_USER_AGENT,
          },
          signal: AbortSignal.timeout(10_000),
        });
      }

      if (!res.ok) {
        return {
          ok: false,
          error: `HTTP ${res.status} ${res.statusText}`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

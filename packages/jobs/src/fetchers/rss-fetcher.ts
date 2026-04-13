/**
 * RSS Fetcher
 *
 * Fetches RSS/Atom/JSON feeds via CP RSSHub proxy or direct fetch.
 * Parses and normalizes feed items for processing.
 */

import { createLogger } from "@synap-core/core";
import type {
  RSSFeedSource,
  NormalizedRSSItem,
  RSSFetchResult,
} from "@synap-core/types";

const logger = createLogger({ module: "rss-fetcher" });

// Re-export types
export type { NormalizedRSSItem, RSSFetchResult };

// ── XML Parsing ──────────────────────────────────────────────────────────────

interface ParsedFeed {
  title: string;
  items: Array<{
    id?: string;
    title?: string;
    link?: string;
    description?: string;
    content?: string;
    pubDate?: string;
    author?: string;
    category?: string | string[];
  }>;
}

/**
 * Simple XML to JSON parser for RSS/Atom feeds.
 * Uses native DOMParser in browser-like environment or regex fallback.
 */
function parseRSSXML(xml: string, feedUrl: string): ParsedFeed {
  const items: ParsedFeed["items"] = [];

  // Try to extract channel title
  const channelTitleMatch = xml.match(
    /<channel>.*?<title>(.*?)<\/title>.*?<\/channel>/s
  );
  const feedTitle =
    channelTitleMatch?.[1]?.replace(/<![CDATA[(.*?)]]>/s, "$1") ||
    new URL(feedUrl).hostname;

  // Extract items - support both RSS <item> and Atom <entry>
  const itemRegex = /<(item|entry)[^>]*>(.*?)<\/\1>/gs;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[2];

    // Extract fields with CDATA support
    const getField = (tag: string): string | undefined => {
      const regex = new RegExp(
        `<${tag}[^>]*>(?:<![CDATA[)?(.*?)(?:]]>)?</${tag}>`,
        "s"
      );
      const m = itemXml.match(regex);
      return m?.[1]?.trim();
    };

    const guid = getField("guid") || getField("id");
    const title = getField("title") || "Untitled";
    const link = getField("link") || getField("id");
    const description =
      getField("description") || getField("summary") || getField("content");
    const pubDate =
      getField("pubDate") || getField("published") || getField("updated");
    const author = getField("author") || getField("creator");
    const category = getField("category");

    // Handle Atom links
    let finalLink = link;
    if (!finalLink || finalLink.startsWith("http") === false) {
      const atomLinkMatch = itemXml.match(/<link[^>]*href="([^"]+)"/);
      if (atomLinkMatch) {
        finalLink = atomLinkMatch[1];
      }
    }

    if (guid || finalLink) {
      items.push({
        id: guid || finalLink!,
        title: title.replace(/<![CDATA[(.*?)]]>/s, "$1"),
        link: finalLink,
        description: description?.replace(/<![CDATA[(.*?)]]>/s, "$1"),
        content: description?.replace(/<![CDATA[(.*?)]]>/s, "$1"),
        pubDate,
        author: author?.replace(/<![CDATA[(.*?)]]>/s, "$1"),
        category: category ? [category] : undefined,
      });
    }
  }

  return { title: feedTitle, items };
}

/**
 * Parse JSON feed format.
 */
function parseJSONFeed(json: unknown, feedUrl: string): ParsedFeed {
  const feed = json as Record<string, unknown>;
  const feedTitle = (feed.title as string) || new URL(feedUrl).hostname;

  const items = ((feed.items as Array<Record<string, unknown>>) || []).map(
    (item) => ({
      id: (item.id as string) || (item.url as string),
      title: (item.title as string) || "Untitled",
      link: (item.url as string) || (item.external_url as string),
      description: (item.summary as string) || (item.content_text as string),
      content: (item.content_html as string) || (item.content_text as string),
      pubDate:
        (item.date_published as string) || (item.date_modified as string),
      author: (item.author as Record<string, unknown>)?.name as string,
      category: item.tags as string | string[] | undefined,
    })
  );

  return { title: feedTitle, items };
}

// ── Content Extraction ───────────────────────────────────────────────────────

/**
 * Extract plain text from HTML content.
 */
function extractTextFromHTML(html: string): string {
  // Simple HTML tag stripping
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

/**
 * Truncate content to max length.
 */
function truncateContent(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).replace(/\s+\S*$/, "") + "...";
}

// ── Fetch Functions ──────────────────────────────────────────────────────────

/**
 * Fetch RSS feed via CP RSSHub proxy.
 */
async function fetchViaCPProxy(
  source: RSSFeedSource,
  rsshubRoute?: string
): Promise<NormalizedRSSItem[]> {
  const cpUrl = process.env.CONTROL_PLANE_URL || process.env.CP_URL;
  if (!cpUrl) {
    throw new Error("CP_URL not configured");
  }

  // Build RSSHub route - either provided or derived from URL
  const route =
    rsshubRoute ||
    `/rss/${encodeURIComponent(new URL(source.url).hostname)}${new URL(source.url).pathname}`;

  const proxyUrl = `${cpUrl}/api/v1/rsshub${route}`;

  logger.debug({ proxyUrl, source: source.url }, "Fetching via CP proxy");

  const response = await fetch(proxyUrl, {
    method: "GET",
    headers: {
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json",
      ...(source.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(
      `CP proxy returned ${response.status}: ${response.statusText}`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  let parsed: ParsedFeed;

  if (contentType.includes("json")) {
    parsed = parseJSONFeed(JSON.parse(text), source.url);
  } else {
    parsed = parseRSSXML(text, source.url);
  }

  // Normalize items
  return parsed.items.map((item) => {
    const content = item.content || item.description || "";
    const contentText = extractTextFromHTML(content);

    return {
      id: item.id || item.link || `${source.url}#${Date.now()}`,
      title: item.title || "Untitled",
      url: item.link || source.url,
      content: truncateContent(content, 5000),
      contentText: truncateContent(contentText, 2000),
      publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      author: item.author,
      categories: Array.isArray(item.category)
        ? item.category
        : item.category
          ? [item.category]
          : [],
      source: {
        name: source.name || parsed.title,
        url: source.url,
        iconUrl: source.iconUrl,
      },
    };
  });
}

/**
 * Fetch RSS feed directly.
 */
async function fetchDirect(
  source: RSSFeedSource
): Promise<NormalizedRSSItem[]> {
  logger.debug({ url: source.url }, "Fetching RSS directly");

  const response = await fetch(source.url, {
    method: "GET",
    headers: {
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json",
      "User-Agent": "SynapFeedBot/1.0 (+https://synap.io/bot)",
      ...(source.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Feed returned ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  let parsed: ParsedFeed;

  if (contentType.includes("json")) {
    parsed = parseJSONFeed(JSON.parse(text), source.url);
  } else {
    parsed = parseRSSXML(text, source.url);
  }

  // Normalize items
  return parsed.items.map((item) => {
    const content = item.content || item.description || "";
    const contentText = extractTextFromHTML(content);

    return {
      id: item.id || item.link || `${source.url}#${Date.now()}`,
      title: item.title || "Untitled",
      url: item.link || source.url,
      content: truncateContent(content, 5000),
      contentText: truncateContent(contentText, 2000),
      publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      author: item.author,
      categories: Array.isArray(item.category)
        ? item.category
        : item.category
          ? [item.category]
          : [],
      source: {
        name: source.name || parsed.title,
        url: source.url,
        iconUrl: source.iconUrl,
      },
    };
  });
}

// ── Main Export ──────────────────────────────────────────────────────────────

/**
 * Fetch RSS items from all configured sources.
 */
export async function fetchRSSItems(
  sources: RSSFeedSource[],
  options: {
    useCpProxy?: boolean;
    rsshubRoute?: string;
    maxItems?: number;
  } = {}
): Promise<RSSFetchResult> {
  const { useCpProxy = true, maxItems = 50 } = options;
  const items: NormalizedRSSItem[] = [];
  const errors: Array<{ source: string; error: string }> = [];

  logger.info(
    { sourceCount: sources.length, useCpProxy },
    "Fetching RSS items"
  );

  for (const source of sources) {
    try {
      const sourceItems = useCpProxy
        ? await fetchViaCPProxy(source, options.rsshubRoute)
        : await fetchDirect(source);

      items.push(...sourceItems);
      logger.debug(
        {
          source: source.url,
          items: sourceItems.length,
        },
        "Fetched RSS source"
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, source: source.url }, "Failed to fetch RSS source");
      errors.push({ source: source.url, error: errorMsg });
    }
  }

  // Sort by published date (newest first) and limit
  items.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  const limitedItems = items.slice(0, maxItems);

  logger.info(
    {
      totalItems: items.length,
      returnedItems: limitedItems.length,
      errors: errors.length,
    },
    "RSS fetch complete"
  );

  return {
    items: limitedItems,
    errors,
    sourceCount: sources.length,
  };
}

/**
 * DirectRSSProvider
 *
 * Fetches RSS/Atom/JSON feeds directly via HTTP.
 * Handles XML parsing, JSON parsing, and content normalization.
 */

import { XMLParser } from "fast-xml-parser";
import type { IFeedProvider } from "../interfaces/IFeedProvider.js";
import type {
  FeedSourceConfig,
  NormalizedRSSItem,
  FeedHealthStatus,
} from "../types/index.js";
import { FeedFetchError, FeedParseError } from "@synap/shared-utils";
import { DirectRSSProviderDefaults } from "../config/RSSProviderConfig.js";

/**
 * Direct RSS feed provider
 *
 * Fetches feeds directly from source URLs with support for RSS, Atom, and JSON formats.
 * Implements retry logic and comprehensive error handling.
 */
export class DirectRSSProvider implements IFeedProvider {
  private readonly userAgent: string;
  private lastFetchTime?: Date;
  private consecutiveFailures = 0;
  private lastError?: string;
  private totalResponseTime = 0;
  private responseCount = 0;

  constructor(userAgent = "SynapFeedService/1.0") {
    this.userAgent = userAgent;
  }

  /**
   * Get provider type identifier
   */
  getProviderType(): string {
    return "direct";
  }

  /**
   * Fetch and normalize feed items
   */
  async fetch(source: FeedSourceConfig): Promise<NormalizedRSSItem[]> {
    const startTime = Date.now();
    const config = this.mergeConfig(source.provider);

    try {
      const response = await this.fetchWithRetry(source.url, config);
      const contentType = response.headers.get("content-type") || "";
      const body = await response.text();

      const items = this.parseFeed(body, contentType, source);

      // Update metrics
      this.lastFetchTime = new Date();
      this.consecutiveFailures = 0;
      this.totalResponseTime += Date.now() - startTime;
      this.responseCount++;

      return items;
    } catch (error) {
      this.consecutiveFailures++;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Validate feed accessibility
   */
  async validate(source: FeedSourceConfig): Promise<boolean> {
    try {
      const config = this.mergeConfig(source.provider);
      const response = await fetch(source.url, {
        method: "HEAD",
        headers: this.buildHeaders(config),
        signal: AbortSignal.timeout(config.timeoutMs || 10000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check provider health status
   */
  async healthCheck(): Promise<FeedHealthStatus> {
    return {
      healthy: this.consecutiveFailures < 3,
      providerType: this.getProviderType(),
      lastSuccessfulFetch: this.lastFetchTime,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      averageResponseTimeMs:
        this.responseCount > 0
          ? Math.round(this.totalResponseTime / this.responseCount)
          : undefined,
      checkedAt: new Date(),
    };
  }

  /**
   * Merge configuration with defaults
   */
  private mergeConfig(
    config: FeedSourceConfig["provider"]
  ): FeedSourceConfig["provider"] {
    return {
      ...DirectRSSProviderDefaults,
      ...config,
      headers: {
        ...DirectRSSProviderDefaults.headers,
        ...config.headers,
      },
    };
  }

  /**
   * Build request headers
   */
  private buildHeaders(
    config: FeedSourceConfig["provider"]
  ): Record<string, string> {
    return {
      "User-Agent": this.userAgent,
      ...config.headers,
    };
  }

  /**
   * Fetch with retry logic
   */
  private async fetchWithRetry(
    url: string,
    config: FeedSourceConfig["provider"]
  ): Promise<Response> {
    const maxAttempts = config.retryAttempts || 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          headers: this.buildHeaders(config),
          signal: AbortSignal.timeout(config.timeoutMs || 30000),
        });

        if (!response.ok) {
          throw new FeedFetchError(
            `HTTP ${response.status}: ${response.statusText}`,
            url,
            response.status
          );
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxAttempts) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await this.sleep(delay);
        }
      }
    }

    throw new FeedFetchError(
      `Failed after ${maxAttempts} attempts: ${lastError?.message}`,
      url,
      undefined,
      lastError
    );
  }

  /**
   * Parse feed content based on format
   */
  private parseFeed(
    body: string,
    contentType: string,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    const parser = source.parser || this.detectParser(contentType, body);

    switch (parser) {
      case "json":
        return this.parseJsonFeed(body, source);
      case "atom":
        return this.parseAtomFeed(body, source);
      case "rss":
      default:
        return this.parseRssFeed(body, source);
    }
  }

  /**
   * Detect parser type from content
   */
  private detectParser(
    contentType: string,
    body: string
  ): "rss" | "atom" | "json" {
    const lowerContentType = contentType.toLowerCase();
    const trimmedBody = body.trim().toLowerCase();

    if (lowerContentType.includes("json") || trimmedBody.startsWith("{")) {
      return "json";
    }

    if (trimmedBody.includes("<feed") && trimmedBody.includes("xmlns")) {
      return "atom";
    }

    return "rss";
  }

  /**
   * Parse RSS 2.0 feed
   */
  private parseRssFeed(
    body: string,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        textNodeName: "#text",
        parseAttributeValue: true,
        trimValues: true,
      });

      const result = parser.parse(body);
      const channel = result?.rss?.channel;

      if (!channel) {
        throw new FeedParseError(
          "Invalid RSS feed: missing channel element",
          source.url
        );
      }

      const feedTitle = channel.title;
      const items = channel.item || [];
      const itemArray = Array.isArray(items) ? items : [items];

      return itemArray.map((item, index): NormalizedRSSItem => {
        const itemObj = item as Record<string, unknown>;
        return {
          id: String(
            (itemObj.guid as Record<string, string>)?.["#text"] ||
              itemObj.guid ||
              itemObj.link ||
              `${source.url}#${index}`
          ),
          title: this.extractText(itemObj.title) || "Untitled",
          content:
            this.extractText(itemObj.description) ||
            this.extractText(itemObj["content:encoded"]),
          summary: this.extractText(itemObj.description)?.substring(0, 500),
          url: String(itemObj.link || ""),
          author: String(itemObj.author || itemObj["dc:creator"] || ""),
          publishedAt: this.parseDate(itemObj.pubDate),
          updatedAt: this.parseDate(itemObj.pubDate),
          categories: this.extractCategories(itemObj.category),
          enclosureUrl: String(
            (itemObj.enclosure as Record<string, string>)?.["@_url"] || ""
          ),
          enclosureType: String(
            (itemObj.enclosure as Record<string, string>)?.["@_type"] || ""
          ),
          source: {
            title: String(feedTitle || ""),
            url: source.url,
            name: source.name,
          },
        };
      });
    } catch (error) {
      if (error instanceof FeedParseError) throw error;
      throw new FeedParseError(
        `Failed to parse RSS feed: ${error instanceof Error ? error.message : String(error)}`,
        source.url,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Parse Atom feed
   */
  private parseAtomFeed(
    body: string,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        textNodeName: "#text",
        parseAttributeValue: true,
        trimValues: true,
      });

      const result = parser.parse(body);
      const feed = result?.feed;

      if (!feed) {
        throw new FeedParseError(
          "Invalid Atom feed: missing feed element",
          source.url
        );
      }

      const feedTitle = feed.title;
      const entries = feed.entry || [];
      const entryArray = Array.isArray(entries) ? entries : [entries];

      return entryArray.map((entry, index): NormalizedRSSItem => {
        const entryObj = entry as Record<string, unknown>;
        return {
          id: String(entryObj.id || `${source.url}#${index}`),
          title: this.extractText(entryObj.title) || "Untitled",
          content:
            this.extractText(entryObj.content) ||
            this.extractText(entryObj.summary),
          summary: this.extractText(entryObj.summary)?.substring(0, 500),
          url: this.extractAtomLink(entryObj.link),
          author: String(
            (entryObj.author as Record<string, string>)?.name || ""
          ),
          publishedAt: this.parseDate(entryObj.published),
          updatedAt: this.parseDate(entryObj.updated),
          categories: this.extractCategories(entryObj.category),
          source: {
            title: String(feedTitle || ""),
            url: source.url,
            name: source.name,
          },
        };
      });
    } catch (error) {
      if (error instanceof FeedParseError) throw error;
      throw new FeedParseError(
        `Failed to parse Atom feed: ${error instanceof Error ? error.message : String(error)}`,
        source.url,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Parse JSON feed (RSS JSON format)
   */
  private parseJsonFeed(
    body: string,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    try {
      const feed = JSON.parse(body) as Record<string, unknown>;
      const items = (feed.items || []) as Record<string, unknown>[];

      return items.map((item, index): NormalizedRSSItem => {
        const authorData = item.author as Record<string, string> | undefined;
        const attachments = item.attachments as
          | Array<{ url?: string; mime_type?: string }>
          | undefined;

        return {
          id: String(
            item.id || item.guid || item.url || `${source.url}#${index}`
          ),
          title: String(item.title || ""),
          content: String(item.content_html || item.content_text || ""),
          summary: String(item.summary || "").substring(0, 500),
          url: String(item.url || ""),
          author: authorData?.name || (item.author as string | undefined),
          publishedAt: this.parseDate(String(item.date_published)),
          updatedAt: this.parseDate(String(item.date_modified)),
          categories: Array.isArray(item.tags)
            ? (item.tags as unknown[]).map(String)
            : [],
          enclosureUrl: attachments?.[0]?.url,
          enclosureType: attachments?.[0]?.mime_type,
          source: {
            title: String(feed.title || ""),
            url: source.url,
            name: source.name,
          },
        };
      });
    } catch (error) {
      throw new FeedParseError(
        `Failed to parse JSON feed: ${error instanceof Error ? error.message : String(error)}`,
        source.url,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Extract text content from parsed XML element
   */
  private extractText(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null) {
      return (value as Record<string, string>)["#text"];
    }
    return undefined;
  }

  /**
   * Extract Atom link URL
   */
  private extractAtomLink(link: unknown): string | undefined {
    if (typeof link === "string") return link;
    if (typeof link === "object" && link !== null) {
      const linkObj = link as Record<string, string>;
      // Handle array of links
      if (Array.isArray(link)) {
        const alternate = link.find(
          (l: Record<string, string>) => l["@_rel"] === "alternate"
        );
        return alternate?.["@_href"] || link[0]?.["@_href"];
      }
      return linkObj["@_href"];
    }
    return undefined;
  }

  /**
   * Extract categories from various formats
   */
  private extractCategories(category: unknown): string[] {
    if (!category) return [];
    if (typeof category === "string") return [category];
    if (Array.isArray(category)) {
      return category
        .map((c) =>
          typeof c === "string" ? c : c?.["@_term"] || c?.["#text"] || String(c)
        )
        .filter(Boolean);
    }
    if (typeof category === "object") {
      const term = (category as Record<string, string>)["@_term"];
      const text = (category as Record<string, string>)["#text"];
      return [term || text].filter(Boolean) as string[];
    }
    return [];
  }

  /**
   * Parse date string to Date object
   */
  private parseDate(dateStr: unknown): Date | undefined {
    if (!dateStr) return undefined;
    const date = new Date(String(dateStr));
    return isNaN(date.getTime()) ? undefined : date;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

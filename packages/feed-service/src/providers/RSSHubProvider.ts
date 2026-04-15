/**
 * RSSHubProvider
 *
 * Provider for RSSHub instances - a versatile RSS feed generator.
 * Supports route-based fetching and caching.
 */

import type { IFeedProvider } from "../interfaces/IFeedProvider.js";
import type {
  FeedSourceConfig,
  NormalizedRSSItem,
  FeedHealthStatus,
} from "../types/index.js";
import { FeedFetchError, FeedParseError } from "@synap/shared-utils";
import type { RSSHubProviderConfig } from "../config/RSSProviderConfig.js";
import { RSSHubProviderDefaults } from "../config/RSSProviderConfig.js";
import { XMLParser } from "fast-xml-parser";

/**
 * RSSHub feed provider
 *
 * Fetches feeds from an RSSHub instance. RSSHub generates RSS feeds from
 * various websites that don't provide native feeds.
 *
 * @example
 * ```typescript
 * const provider = new RSSHubProvider({
 *   url: "https://rsshub.app",
 *   enableCache: true
 * });
 * const items = await provider.fetch({
 *   url: "https://rsshub.app/github/trending/daily/javascript",
 *   provider: { type: "rsshub" }
 * });
 * ```
 */
export class RSSHubProvider implements IFeedProvider {
  private readonly config: RSSHubProviderConfig;
  private lastFetchTime?: Date;
  private consecutiveFailures = 0;
  private lastError?: string;
  private totalResponseTime = 0;
  private responseCount = 0;

  constructor(config: Partial<RSSHubProviderConfig> = {}) {
    this.config = {
      ...RSSHubProviderDefaults,
      ...config,
    } as RSSHubProviderConfig;
  }

  /**
   * Get provider type identifier
   */
  getProviderType(): string {
    return "rsshub";
  }

  /**
   * Fetch and normalize feed items from RSSHub
   */
  async fetch(source: FeedSourceConfig): Promise<NormalizedRSSItem[]> {
    const startTime = Date.now();

    try {
      const url = this.buildUrl(source.url);
      const response = await this.fetchWithRetry(url);
      const body = await response.text();

      const items = this.parseRssContent(body, source);

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
   * Validate RSSHub route accessibility
   */
  async validate(source: FeedSourceConfig): Promise<boolean> {
    try {
      const url = this.buildUrl(source.url);
      const response = await fetch(url, {
        method: "HEAD",
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(10000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check RSSHub instance health
   */
  async healthCheck(): Promise<FeedHealthStatus> {
    const baseUrl = this.config.url;
    let healthy = this.consecutiveFailures < 3;

    // Try to hit RSSHub health endpoint if available
    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      healthy = response.ok && healthy;
    } catch {
      // Health endpoint not available, rely on fetch metrics
    }

    return {
      healthy,
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
   * Build full URL with RSSHub parameters
   */
  private buildUrl(sourceUrl: string): string {
    const url = new URL(sourceUrl);

    // Add cache parameter if enabled
    if (this.config.enableCache && this.config.cacheTtlSeconds) {
      url.searchParams.set("cache_ttl", String(this.config.cacheTtlSeconds));
    }

    // Add access key if provided
    if (this.config.accessKey) {
      url.searchParams.set("key", this.config.accessKey);
    }

    return url.toString();
  }

  /**
   * Build request headers
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": "SynapFeedService/1.0",
      Accept: "application/rss+xml, application/atom+xml, application/xml, */*",
    };

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  /**
   * Fetch with retry logic
   */
  private async fetchWithRetry(url: string): Promise<globalThis.Response> {
    const maxAttempts = this.config.retryAttempts || 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          headers: this.buildHeaders(),
          signal: AbortSignal.timeout(this.config.timeoutMs || 30000),
        });

        if (!response.ok) {
          // RSSHub returns 404 for invalid routes
          if (response.status === 404) {
            throw new FeedFetchError(
              `RSSHub route not found: ${url}`,
              url,
              404
            );
          }

          throw new FeedFetchError(
            `RSSHub returned HTTP ${response.status}: ${response.statusText}`,
            url,
            response.status
          );
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await this.sleep(delay);
        }
      }
    }

    throw new FeedFetchError(
      `RSSHub fetch failed after ${maxAttempts} attempts: ${lastError?.message}`,
      url,
      undefined,
      lastError
    );
  }

  /**
   * Parse RSS content from RSSHub response
   */
  private parseRssContent(
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

      // RSSHub can return both RSS and Atom formats
      if (result?.rss?.channel) {
        return this.parseRssFormat(result.rss.channel, source);
      }

      if (result?.feed) {
        return this.parseAtomFormat(result.feed, source);
      }

      throw new FeedParseError(
        "Unrecognized RSSHub response format",
        source.url
      );
    } catch (error) {
      if (error instanceof FeedParseError) throw error;
      throw new FeedParseError(
        `Failed to parse RSSHub response: ${error instanceof Error ? error.message : String(error)}`,
        source.url,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Parse RSS 2.0 format
   */
  private parseRssFormat(
    channel: Record<string, unknown>,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    const feedTitle = channel.title as string | undefined;
    const items = channel.item || [];
    const itemArray = Array.isArray(items) ? items : [items];

    return itemArray.map((item, index): NormalizedRSSItem => {
      const itemObj = item as Record<string, unknown>;
      const enclosure = itemObj.enclosure as Record<string, string> | undefined;

      return {
        id: this.extractId(itemObj, index, source.url),
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
        enclosureUrl: enclosure?.["@_url"],
        enclosureType: enclosure?.["@_type"],
        source: {
          title: String(feedTitle || ""),
          url: source.url,
          name: source.name,
        },
      };
    });
  }

  /**
   * Parse Atom format
   */
  private parseAtomFormat(
    feed: Record<string, unknown>,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    const feedTitle = feed.title as string | undefined;
    const entries = feed.entry || [];
    const entryArray = Array.isArray(entries) ? entries : [entries];

    return entryArray.map((entry, index): NormalizedRSSItem => {
      const entryObj = entry as Record<string, unknown>;
      const authorObj = entryObj.author as Record<string, string> | undefined;

      return {
        id: this.extractId(entryObj, index, source.url),
        title: this.extractText(entryObj.title) || "Untitled",
        content:
          this.extractText(entryObj.content) ||
          this.extractText(entryObj.summary),
        summary: this.extractText(entryObj.summary)?.substring(0, 500),
        url: this.extractLink(entryObj.link),
        author: authorObj?.name,
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
  }

  /**
   * Extract item ID
   */
  private extractId(
    item: Record<string, unknown>,
    index: number,
    sourceUrl: string
  ): string {
    const guid = item.guid as Record<string, string> | string | undefined;
    const guidText =
      typeof guid === "object" && guid !== null ? guid["#text"] : guid;
    return String(guidText || item.id || item.link || `${sourceUrl}#${index}`);
  }

  /**
   * Extract text from XML element
   */
  private extractText(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null) {
      return (value as Record<string, string>)["#text"] as string | undefined;
    }
    return undefined;
  }

  /**
   * Extract link URL from Atom format
   */
  private extractLink(link: unknown): string | undefined {
    if (typeof link === "string") return link;
    if (typeof link === "object" && link !== null) {
      if (Array.isArray(link)) {
        const linkArray = link as Array<Record<string, string>>;
        const alternate = linkArray.find((l) => l["@_rel"] === "alternate");
        return alternate?.["@_href"] || linkArray[0]?.["@_href"];
      }
      return (link as Record<string, string>)["@_href"];
    }
    return undefined;
  }

  /**
   * Extract categories
   */
  private extractCategories(category: unknown): string[] {
    if (!category) return [];
    if (typeof category === "string") return [category];
    if (Array.isArray(category)) {
      return (category as Array<Record<string, string> | string>)
        .map((c) => {
          if (typeof c === "string") return c;
          const cat = c as Record<string, string>;
          return cat["@_term"] || cat["#text"] || String(c);
        })
        .filter(Boolean);
    }
    if (typeof category === "object") {
      const cat = category as Record<string, string>;
      const term = cat["@_term"];
      const text = cat["#text"];
      return [term || text].filter(Boolean) as string[];
    }
    return [];
  }

  /**
   * Parse date string
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

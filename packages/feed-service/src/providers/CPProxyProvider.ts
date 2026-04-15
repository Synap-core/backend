/**
 * CPProxyProvider
 *
 * Provider for Control Plane proxy - handles rate-limited feeds with
 * backward compatibility and regional routing.
 */

import type { IFeedProvider } from "../interfaces/IFeedProvider.js";
import type {
  FeedSourceConfig,
  NormalizedRSSItem,
  FeedHealthStatus,
} from "../types/index.js";
import { FeedFetchError, FeedParseError } from "@synap/shared-utils";
import type { CPProxyProviderConfig } from "../config/RSSProviderConfig.js";
import { CPProxyProviderDefaults } from "../config/RSSProviderConfig.js";
import { XMLParser } from "fast-xml-parser";

/**
 * Control Plane proxy feed provider
 *
 * Routes feed requests through the Control Plane proxy for:
 * - Rate-limited feeds (managed rate limiting)
 * - Geographic routing optimization
 * - Backward compatibility with legacy feeds
 * - Centralized feed monitoring
 *
 * @example
 * ```typescript
 * const provider = new CPProxyProvider({
 *   url: "https://cp.synap.io/api/feeds/proxy",
 *   apiKey: "cp-api-key",
 *   rateLimitAware: true
 * });
 * const items = await provider.fetch({
 *   url: "https://example.com/limited-feed.xml",
 *   provider: { type: "cpproxy" }
 * });
 * ```
 */
export class CPProxyProvider implements IFeedProvider {
  private readonly config: CPProxyProviderConfig;
  private lastFetchTime?: Date;
  private consecutiveFailures = 0;
  private lastError?: string;
  private totalResponseTime = 0;
  private responseCount = 0;
  private rateLimitRemaining?: number;
  private rateLimitReset?: Date;

  constructor(config: Partial<CPProxyProviderConfig> = {}) {
    this.config = {
      ...CPProxyProviderDefaults,
      ...config,
    } as CPProxyProviderConfig;

    if (!this.config.url) {
      throw new Error("CPProxyProvider requires a URL");
    }

    if (!this.config.apiKey) {
      throw new Error("CPProxyProvider requires an API key");
    }
  }

  /**
   * Get provider type identifier
   */
  getProviderType(): string {
    return "cpproxy";
  }

  /**
   * Fetch and normalize feed items via CP proxy
   */
  async fetch(source: FeedSourceConfig): Promise<NormalizedRSSItem[]> {
    const startTime = Date.now();

    // Check rate limit before fetching
    if (this.config.rateLimitAware && this.isRateLimited()) {
      const resetTime = this.rateLimitReset?.toISOString() || "unknown";
      throw new FeedFetchError(
        `Rate limit exceeded. Reset at: ${resetTime}`,
        source.url,
        429
      );
    }

    try {
      const response = await this.fetchWithRetry(source);
      const body = await response.text();

      // Update rate limit info from headers
      this.updateRateLimitInfo(response);

      const items = this.parseResponse(body, source);

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
   * Validate feed accessibility via CP proxy
   */
  async validate(source: FeedSourceConfig): Promise<boolean> {
    try {
      const url = this.buildProxyUrl(source.url, true); // validation mode
      const response = await fetch(url, {
        method: "HEAD",
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(15000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check CP proxy health
   */
  async healthCheck(): Promise<FeedHealthStatus> {
    const baseUrl = this.config.url;
    let healthy = this.consecutiveFailures < 3;

    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      healthy = response.ok && healthy;
    } catch {
      // Health endpoint not available
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
   * Build proxy URL with parameters
   */
  private buildProxyUrl(targetUrl: string, validate = false): string {
    const url = new URL(`${this.config.url}/fetch`);

    url.searchParams.set("url", targetUrl);

    if (validate) {
      url.searchParams.set("validate", "true");
    }

    if (this.config.region) {
      url.searchParams.set("region", this.config.region);
    }

    if (this.config.legacyMode) {
      url.searchParams.set("legacy", "true");
    }

    return url.toString();
  }

  /**
   * Build request headers
   */
  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "User-Agent": "SynapFeedService/1.0",
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, application/json, */*",
    };
  }

  /**
   * Check if currently rate limited
   */
  private isRateLimited(): boolean {
    if (this.rateLimitRemaining === undefined) return false;
    if (this.rateLimitRemaining > 0) return false;

    // Check if reset time has passed
    if (this.rateLimitReset && new Date() >= this.rateLimitReset) {
      this.rateLimitRemaining = undefined;
      return false;
    }

    return true;
  }

  /**
   * Update rate limit info from response headers
   */
  private updateRateLimitInfo(response: globalThis.Response): void {
    const remaining = response.headers.get("X-RateLimit-Remaining");
    const reset = response.headers.get("X-RateLimit-Reset");

    if (remaining) {
      this.rateLimitRemaining = parseInt(remaining, 10);
    }

    if (reset) {
      const resetTimestamp = parseInt(reset, 10);
      // Handle both seconds and milliseconds
      this.rateLimitReset = new Date(
        resetTimestamp > 1e10 ? resetTimestamp : resetTimestamp * 1000
      );
    }
  }

  /**
   * Fetch with retry logic
   */
  private async fetchWithRetry(
    source: FeedSourceConfig
  ): Promise<globalThis.Response> {
    const maxAttempts = this.config.retryAttempts || 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const url = this.buildProxyUrl(source.url);
        const response = await fetch(url, {
          headers: this.buildHeaders(),
          signal: AbortSignal.timeout(this.config.timeoutMs || 60000),
        });

        if (!response.ok) {
          // Handle specific CP proxy errors
          if (response.status === 429) {
            const retryAfter = response.headers.get("Retry-After");
            throw new FeedFetchError(
              `CP Proxy rate limit exceeded. Retry after: ${retryAfter || "unknown"}`,
              source.url,
              429
            );
          }

          if (response.status === 401) {
            throw new FeedFetchError(
              "CP Proxy authentication failed. Check API key.",
              source.url,
              401
            );
          }

          if (response.status === 403) {
            throw new FeedFetchError(
              "CP Proxy access denied. Feed may be restricted.",
              source.url,
              403
            );
          }

          throw new FeedFetchError(
            `CP Proxy returned HTTP ${response.status}: ${response.statusText}`,
            source.url,
            response.status
          );
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on auth errors
        if (
          lastError instanceof FeedFetchError &&
          lastError.statusCode === 401
        ) {
          throw lastError;
        }

        if (attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
          await this.sleep(delay);
        }
      }
    }

    throw new FeedFetchError(
      `CP Proxy fetch failed after ${maxAttempts} attempts: ${lastError?.message}`,
      source.url,
      undefined,
      lastError
    );
  }

  /**
   * Parse CP proxy response
   */
  private parseResponse(
    body: string,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    // CP proxy may return wrapped response with metadata
    let content = body;
    let contentType = "application/xml";

    try {
      const parsed = JSON.parse(body);
      // Check if it's a wrapped response
      if (parsed.data || parsed.content || parsed.body) {
        content = parsed.data || parsed.content || parsed.body;
        contentType = parsed.contentType || contentType;
      }
    } catch {
      // Not JSON, treat as raw feed content
    }

    // Parse based on content type
    if (contentType.includes("json")) {
      return this.parseJsonFeed(content, source);
    }

    return this.parseXmlFeed(content, source);
  }

  /**
   * Parse XML feed (RSS or Atom)
   */
  private parseXmlFeed(
    body: string,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      parseAttributeValue: true,
      trimValues: true,
    });

    const result = parser.parse(body);

    if (result?.rss?.channel) {
      return this.parseRssItems(result.rss.channel, source);
    }

    if (result?.feed) {
      return this.parseAtomItems(result.feed, source);
    }

    throw new FeedParseError(
      "Unrecognized feed format from CP proxy",
      source.url
    );
  }

  /**
   * Parse RSS items
   */
  private parseRssItems(
    channel: Record<string, unknown>,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    const feedTitle = channel.title as string | undefined;
    const items = channel.item || [];
    const itemArray = Array.isArray(items) ? items : [items];

    return itemArray.map(
      (item, index): NormalizedRSSItem => ({
        id: this.extractId(item, index, source.url),
        title: this.extractText(item.title) || "Untitled",
        content:
          this.extractText(item.description) ||
          this.extractText(item["content:encoded"]),
        summary: this.extractText(item.description)?.substring(0, 500),
        url: item.link,
        author: item.author || item["dc:creator"],
        publishedAt: this.parseDate(item.pubDate),
        updatedAt: this.parseDate(item.pubDate),
        categories: this.extractCategories(item.category),
        enclosureUrl: item.enclosure?.["@_url"],
        enclosureType: item.enclosure?.["@_type"],
        source: {
          title: feedTitle,
          url: source.url,
          name: source.name,
        },
      })
    );
  }

  /**
   * Parse Atom items
   */
  private parseAtomItems(
    feed: Record<string, unknown>,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    const feedTitle = feed.title as string | undefined;
    const entries = feed.entry || [];
    const entryArray = Array.isArray(entries) ? entries : [entries];

    return entryArray.map(
      (entry, index): NormalizedRSSItem => ({
        id: this.extractId(entry, index, source.url),
        title: this.extractText(entry.title) || "Untitled",
        content:
          this.extractText(entry.content) || this.extractText(entry.summary),
        summary: this.extractText(entry.summary)?.substring(0, 500),
        url: this.extractLink(entry.link),
        author: entry.author?.name,
        publishedAt: this.parseDate(entry.published),
        updatedAt: this.parseDate(entry.updated),
        categories: this.extractCategories(entry.category),
        source: {
          title: feedTitle,
          url: source.url,
          name: source.name,
        },
      })
    );
  }

  /**
   * Parse JSON feed
   */
  private parseJsonFeed(
    body: string,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
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
   * Extract text content
   */
  private extractText(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null) {
      return (value as Record<string, string>)["#text"] as string | undefined;
    }
    return undefined;
  }

  /**
   * Extract Atom link
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
   * Parse date
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

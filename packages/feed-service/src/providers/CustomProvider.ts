/**
 * CustomProvider
 *
 * Extensible provider for custom feed fetching implementations.
 * Allows injection of custom fetch and parse logic.
 */

import type { IFeedProvider } from "../interfaces/IFeedProvider.js";
import type {
  FeedSourceConfig,
  NormalizedRSSItem,
  FeedHealthStatus,
} from "../types/index.js";
import { FeedFetchError } from "@synap/shared-utils";
import type { CustomProviderConfig } from "../config/RSSProviderConfig.js";
import { CustomProviderDefaults } from "../config/RSSProviderConfig.js";

/**
 * Custom fetch function type
 */
export type CustomFetchFunction = (
  url: string,
  config: CustomProviderConfig,
  headers: Record<string, string>
) => Promise<{ body: string; contentType: string }>;

/**
 * Custom parse function type
 */
export type CustomParseFunction = (
  body: string,
  contentType: string,
  source: FeedSourceConfig
) => NormalizedRSSItem[];

/**
 * Custom provider registry
 */
const customFetchers = new Map<string, CustomFetchFunction>();
const customParsers = new Map<string, CustomParseFunction>();

/**
 * Custom feed provider
 *
 * Allows registration of custom fetch and parse implementations for
 * specialized feed sources that don't fit standard RSS/Atom/JSON formats.
 *
 * @example
 * ```typescript
 * // Register a custom fetcher for a proprietary API
 * CustomProvider.registerFetcher("myapi", async (url, config, headers) => {
 *   const response = await fetch(url, { headers });
 *   return { body: await response.text(), contentType: "application/json" };
 * });
 *
 * // Register a custom parser
 * CustomProvider.registerParser("myapi", (body, contentType, source) => {
 *   const data = JSON.parse(body);
 *   return data.items.map(item => ({
 *     id: item.id,
 *     title: item.headline,
 *     content: item.body,
 *     source: { url: source.url, name: source.name }
 *   }));
 * });
 *
 * // Use the custom provider
 * const provider = new CustomProvider({
 *   fetcherId: "myapi",
 *   parserId: "myapi"
 * });
 * ```
 */
export class CustomProvider implements IFeedProvider {
  private readonly config: CustomProviderConfig;
  private lastFetchTime?: Date;
  private consecutiveFailures = 0;
  private lastError?: string;
  private totalResponseTime = 0;
  private responseCount = 0;

  constructor(config: Partial<CustomProviderConfig> = {}) {
    this.config = {
      ...CustomProviderDefaults,
      customConfig: {},
      ...config,
    } as CustomProviderConfig;

    if (!this.config.fetcherId) {
      throw new Error("CustomProvider requires a fetcherId");
    }
  }

  /**
   * Register a custom fetch function
   *
   * @param id - Unique identifier for the fetcher
   * @param fetcher - Fetch function implementation
   */
  static registerFetcher(id: string, fetcher: CustomFetchFunction): void {
    customFetchers.set(id, fetcher);
  }

  /**
   * Register a custom parse function
   *
   * @param id - Unique identifier for the parser
   * @param parser - Parse function implementation
   */
  static registerParser(id: string, parser: CustomParseFunction): void {
    customParsers.set(id, parser);
  }

  /**
   * Unregister a custom fetch function
   *
   * @param id - Fetcher identifier to remove
   */
  static unregisterFetcher(id: string): void {
    customFetchers.delete(id);
  }

  /**
   * Unregister a custom parse function
   *
   * @param id - Parser identifier to remove
   */
  static unregisterParser(id: string): void {
    customParsers.delete(id);
  }

  /**
   * Get provider type identifier
   */
  getProviderType(): string {
    return "custom";
  }

  /**
   * Fetch and normalize feed items using custom implementation
   */
  async fetch(source: FeedSourceConfig): Promise<NormalizedRSSItem[]> {
    const startTime = Date.now();

    const fetcher = customFetchers.get(this.config.fetcherId);
    if (!fetcher) {
      throw new FeedFetchError(
        `Custom fetcher "${this.config.fetcherId}" not registered`,
        source.url
      );
    }

    try {
      const { body, contentType } = await fetcher(
        source.url,
        this.config,
        this.buildHeaders(source)
      );

      const items = this.parseItems(body, contentType, source);

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
   * Validate feed accessibility using custom fetcher
   */
  async validate(source: FeedSourceConfig): Promise<boolean> {
    const fetcher = customFetchers.get(this.config.fetcherId);
    if (!fetcher) return false;

    try {
      await fetcher(source.url, this.config, this.buildHeaders(source));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check custom provider health
   */
  async healthCheck(): Promise<FeedHealthStatus> {
    const fetcherExists = customFetchers.has(this.config.fetcherId);
    const parserExists =
      !this.config.parserId || customParsers.has(this.config.parserId);

    return {
      healthy: fetcherExists && parserExists && this.consecutiveFailures < 3,
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
   * Build request headers
   */
  private buildHeaders(source: FeedSourceConfig): Record<string, string> {
    return {
      "User-Agent": "SynapFeedService/1.0",
      ...this.config.headers,
      ...source.headers,
    };
  }

  /**
   * Parse items using custom or default parser
   */
  private parseItems(
    body: string,
    contentType: string,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    // Use custom parser if specified
    if (this.config.parserId) {
      const parser = customParsers.get(this.config.parserId);
      if (parser) {
        return parser(body, contentType, source);
      }
      throw new FeedFetchError(
        `Custom parser "${this.config.parserId}" not registered`,
        source.url
      );
    }

    // Auto-detect and use default parser
    return this.autoParse(body, contentType, source);
  }

  /**
   * Auto-parse based on content type
   */
  private autoParse(
    body: string,
    contentType: string,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    const lowerContentType = contentType.toLowerCase();

    if (lowerContentType.includes("json")) {
      return this.parseJson(body, source);
    }

    // Default to returning raw content as single item
    return [
      {
        id: `${source.url}#${Date.now()}`,
        title: "Custom Feed Item",
        categories: [],
        content: body,
        source: {
          url: source.url,
          name: source.name,
        },
      },
    ];
  }

  /**
   * Parse JSON feed
   */
  private parseJson(
    body: string,
    source: FeedSourceConfig
  ): NormalizedRSSItem[] {
    try {
      const data = JSON.parse(body) as Record<string, unknown>;

      // Try to extract items from common JSON feed formats
      const items = (data.items ||
        data.entries ||
        data.results ||
        data.data || [data]) as Record<string, unknown>[];
      const itemArray = Array.isArray(items) ? items : [items];

      return itemArray.map((item, index): NormalizedRSSItem => {
        const cats = item.categories || item.tags;
        return {
          id: String(
            item.id || item.guid || item.key || `${source.url}#${index}`
          ),
          title: String(
            item.title || item.name || item.headline || `Item ${index + 1}`
          ),
          content: String(
            item.content ||
              item.description ||
              item.body ||
              item.summary ||
              item.text ||
              ""
          ),
          summary: String(item.summary || item.excerpt || "").substring(0, 500),
          url: String(item.url || item.link || item.permalink || ""),
          author: String(item.author || item.creator || item.byline || ""),
          publishedAt: this.parseDate(
            item.publishedAt || item.date || item.createdAt
          ),
          updatedAt: this.parseDate(item.updatedAt || item.modifiedAt),
          categories: Array.isArray(cats) ? cats.map(String) : [],
          source: {
            url: source.url,
            name: source.name,
          },
        };
      });
    } catch {
      // Return raw JSON as single item if parsing fails
      return [
        {
          id: `${source.url}#${Date.now()}`,
          title: "Custom Feed Item",
          categories: [],
          content: body,
          source: {
            url: source.url,
            name: source.name,
          },
        },
      ];
    }
  }

  /**
   * Parse date from various formats
   */
  private parseDate(dateValue: unknown): Date | undefined {
    if (!dateValue) return undefined;

    if (dateValue instanceof Date) {
      return isNaN(dateValue.getTime()) ? undefined : dateValue;
    }

    if (typeof dateValue === "number") {
      // Handle Unix timestamps (seconds or milliseconds)
      const timestamp = dateValue > 1e10 ? dateValue : dateValue * 1000;
      const date = new Date(timestamp);
      return isNaN(date.getTime()) ? undefined : date;
    }

    const date = new Date(String(dateValue));
    return isNaN(date.getTime()) ? undefined : date;
  }
}

/**
 * IFeedProvider Interface
 *
 * Defines the contract for RSS/Atom feed providers.
 * Implementations handle fetching and normalizing feed content from various sources.
 */

import type {
  FeedSourceConfig,
  NormalizedRSSItem,
  FeedHealthStatus,
} from "../types/index.js";

/**
 * Feed provider interface
 *
 * All feed providers must implement this interface to be used by the feed service.
 * Providers are responsible for fetching raw feed data and normalizing it into
 * a common format (NormalizedRSSItem).
 */
export interface IFeedProvider {
  /**
   * Fetch items from a feed source
   *
   * @param source - Feed source configuration
   * @returns Promise resolving to array of normalized feed items
   * @throws FeedFetchError if the fetch fails
   * @throws FeedParseError if the response cannot be parsed
   *
   * @example
   * ```typescript
   * const provider = new DirectRSSProvider();
   * const items = await provider.fetch({
   *   url: "https://example.com/feed.xml",
   *   provider: { type: "direct", timeoutMs: 30000 }
   * });
   * ```
   */
  fetch(source: FeedSourceConfig): Promise<NormalizedRSSItem[]>;

  /**
   * Validate that a feed source is accessible and valid
   *
   * Performs a lightweight check to verify the feed can be fetched
   * and parsed. Does not return feed items.
   *
   * @param source - Feed source configuration to validate
   * @returns Promise resolving to true if valid, false otherwise
   *
   * @example
   * ```typescript
   * const isValid = await provider.validate({
   *   url: "https://example.com/feed.xml",
   *   provider: { type: "direct" }
   * });
   * if (!isValid) {
   *   console.error("Feed is not accessible");
   * }
   * ```
   */
  validate(source: FeedSourceConfig): Promise<boolean>;

  /**
   * Check provider health status
   *
   * Returns the current health status of the provider, including
   * recent error counts and response times.
   *
   * @returns Promise resolving to health status
   *
   * @example
   * ```typescript
   * const health = await provider.healthCheck();
   * if (!health.healthy) {
   *   console.warn(`Provider unhealthy: ${health.lastError}`);
   * }
   * ```
   */
  healthCheck(): Promise<FeedHealthStatus>;

  /**
   * Get the provider type identifier
   *
   * @returns Provider type string (e.g., "direct", "rsshub", "cpproxy")
   *
   * @example
   * ```typescript
   * const type = provider.getProviderType(); // "direct"
   * ```
   */
  getProviderType(): string;
}

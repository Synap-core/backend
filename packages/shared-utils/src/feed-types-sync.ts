/**
 * Feed Types
 *
 * Re-exports the canonical types from @synap-core/types for back-compat.
 *
 * RSS-specific types (RSSFeedConfig, FeedProviderConfig, FeedSourceConfig,
 * FeedSource, FeedPreferences, ClassifiedFeedItem) are no longer maintained
 * here — they are obsolete. The remaining workers use types from
 * @synap-core/types:
 *   - ProactiveFeedConfig
 *   - FeedExecutionPayload
 *   - FeedMessageMetadata
 *   - FeedStatus
 *   - NormalizedRSSItem
 *   - FeedFetchResult
 *   - Type guards: isProactiveFeedConfig, isFeedMessageMetadata
 *
 * @module feed-types-sync
 */

export type {
  FeedExecutionPayload,
  ProactiveFeedConfig,
  FeedMessageMetadata,
  FeedStatus,
  FeedConfig,
  NormalizedRSSItem,
  RSSFetchResult,
  BaseFeedConfig,
} from "@synap-core/types";

export {
  isProactiveFeedConfig,
  isFeedMessageMetadata,
  normalizeRelevanceScore,
  createFeedMessageMetadata,
} from "@synap-core/types";

/**
 * Feed fetch error — thrown when a feed provider fails to fetch or parse.
 *
 * Originally imported from @synap/shared-utils by CustomProvider (feed-service).
 * Previously missing — defined here to fix the build.
 */
export class FeedFetchError extends Error {
  public readonly url?: string;
  constructor(message: string, url?: string) {
    super(message);
    this.name = "FeedFetchError";
    this.url = url;
  }
}

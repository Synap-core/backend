/**
 * IFeedRepository Interface
 *
 * Defines the contract for persisting and retrieving feed configurations,
 * items, and execution history.
 */

import type {
  FeedSourceConfig,
  FeedFetchResult,
  FeedRepositoryQuery,
  FeedStatistics,
  NormalizedRSSItem,
} from "../types/index.js";

/**
 * Feed configuration record
 */
export interface FeedConfigRecord {
  /** Unique feed configuration ID */
  id: string;
  /** Workspace ID (null for pod-wide feeds) */
  workspaceId: string | null;
  /** User ID who owns/configured the feed */
  userId: string;
  /** Feed display name */
  name: string;
  /** Feed description */
  description?: string;
  /** Source configuration */
  source: FeedSourceConfig;
  /** Schedule expression */
  schedule: string;
  /** Timezone for scheduling */
  timezone: string;
  /** Whether the feed is active */
  isActive: boolean;
  /** Classifier type to use */
  classifierType: string;
  /** Publisher type to use */
  publisherType: string;
  /** Target channel ID for publishing */
  targetChannelId: string;
  /** Maximum items per fetch */
  maxItemsPerFetch: number;
  /** Minimum relevance score for publishing */
  minRelevanceScore: number;
  /** Created timestamp */
  createdAt: Date;
  /** Updated timestamp */
  updatedAt: Date;
  /** Last fetch result */
  lastFetchResult?: FeedFetchResult;
  /** Next scheduled run */
  nextRunAt?: Date;
}

/**
 * Feed item record (persisted after deduplication check)
 */
export interface FeedItemRecord {
  /** Unique item ID */
  id: string;
  /** Feed configuration ID */
  feedConfigId: string;
  /** Original normalized item */
  item: NormalizedRSSItem;
  /** Whether it was published */
  published: boolean;
  /** Publication timestamp */
  publishedAt?: Date;
  /** Channel message ID if published */
  channelMessageId?: string;
  /** Deduplication hash */
  contentHash: string;
  /** Created timestamp */
  createdAt: Date;
}

/**
 * Feed repository interface
 *
 * Repositories handle persistence of feed configurations, fetched items,
 * and execution history. They also provide deduplication support.
 */
export interface IFeedRepository {
  // ============================================================================
  // Feed Configuration Operations
  // ============================================================================

  /**
   * Create a new feed configuration
   *
   * @param config - Feed configuration to create
   * @returns Promise resolving to the created record
   */
  createConfig(
    config: Omit<FeedConfigRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<FeedConfigRecord>;

  /**
   * Get a feed configuration by ID
   *
   * @param id - Feed configuration ID
   * @returns Promise resolving to the record or null if not found
   */
  getConfig(id: string): Promise<FeedConfigRecord | null>;

  /**
   * Update a feed configuration
   *
   * @param id - Feed configuration ID
   * @param updates - Properties to update
   * @returns Promise resolving to the updated record
   */
  updateConfig(
    id: string,
    updates: Partial<Omit<FeedConfigRecord, "id" | "createdAt">>
  ): Promise<FeedConfigRecord>;

  /**
   * Delete a feed configuration
   *
   * @param id - Feed configuration ID
   * @returns Promise resolving to true if deleted
   */
  deleteConfig(id: string): Promise<boolean>;

  /**
   * Query feed configurations
   *
   * @param query - Query options
   * @returns Promise resolving to matching records and total count
   */
  queryConfigs(
    query: FeedRepositoryQuery
  ): Promise<{ items: FeedConfigRecord[]; total: number }>;

  // ============================================================================
  // Feed Item Operations
  // ============================================================================

  /**
   * Store feed items (after deduplication)
   *
   * @param feedConfigId - Parent feed configuration ID
   * @param items - Items to store
   * @returns Promise resolving to stored records
   */
  storeItems(
    feedConfigId: string,
    items: Omit<FeedItemRecord, "id" | "createdAt">[]
  ): Promise<FeedItemRecord[]>;

  /**
   * Check if items already exist (deduplication)
   *
   * @param feedConfigId - Feed configuration ID
   * @param contentHashes - Array of content hashes to check
   * @returns Promise resolving to array of existing hashes
   */
  findExistingItems(
    feedConfigId: string,
    contentHashes: string[]
  ): Promise<string[]>;

  /**
   * Get items for a feed
   *
   * @param feedConfigId - Feed configuration ID
   * @param options - Query options
   * @returns Promise resolving to item records
   */
  getItems(
    feedConfigId: string,
    options?: {
      published?: boolean;
      limit?: number;
      cursor?: string;
    }
  ): Promise<{ items: FeedItemRecord[]; nextCursor?: string }>;

  // ============================================================================
  // Statistics and Metadata
  // ============================================================================

  /**
   * Get feed statistics
   *
   * @param feedConfigId - Feed configuration ID
   * @returns Promise resolving to statistics
   */
  getStatistics(feedConfigId: string): Promise<FeedStatistics>;

  /**
   * Record a fetch result
   *
   * @param feedConfigId - Feed configuration ID
   * @param result - Fetch result to record
   * @returns Promise resolving when recorded
   */
  recordFetchResult(
    feedConfigId: string,
    result: FeedFetchResult
  ): Promise<void>;

  // ============================================================================
  // Repository Metadata
  // ============================================================================

  /**
   * Get repository type identifier
   *
   * @returns Repository type string
   */
  getRepositoryType(): string;
}

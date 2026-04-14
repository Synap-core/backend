/**
 * Feed Types Synchronization
 *
 * This file ensures type consistency across all repos:
 * - @synap-core/types (canonical source)
 * - @synap/shared-utils (re-exports + legacy)
 * - @synap/feed-service (service-specific)
 * - synap-intelligence-service (IS classification)
 * - relay-app (frontend)
 *
 * @module feed-types-sync
 */

// ============================================================================
// Core Types (Source of Truth: @synap-core/types)
// ============================================================================

/**
 * Feed provider configuration
 * Defines how to fetch RSS/Atom feeds
 */
export interface FeedProviderConfig {
  /** Provider type - determines fetching strategy */
  type: "direct" | "rsshub" | "cpproxy" | "custom";
  /** Base URL for the provider (required for rsshub, cpproxy) */
  url?: string;
  /** API key for authenticated providers */
  apiKey?: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Number of retry attempts */
  retryAttempts?: number;
  /** Custom headers for requests */
  headers?: Record<string, string>;
}

/**
 * Feed source configuration
 * A complete feed source with provider settings
 */
export interface FeedSourceConfig {
  /** Feed URL to fetch from */
  url: string;
  /** Provider configuration */
  provider: FeedProviderConfig;
  /** Parser type - auto-detected if not specified */
  parser?: "rss" | "atom" | "json";
  /** Custom headers for this specific feed */
  headers?: Record<string, string>;
  /** Human-readable feed name */
  name?: string;
  /** Feed icon URL */
  iconUrl?: string;
}

/**
 * User feed preferences
 * Defines personalization settings
 */
export interface FeedPreferences {
  /** User's interest topics */
  interests: string[];
  /** Persona for content tailoring (e.g., 'cto', 'marketing', 'founder') */
  persona: string;
  /** Update frequency */
  frequency: "realtime" | "hourly" | "daily" | "weekly";
  /** RSS feed sources */
  sources: FeedSource[];
}

/**
 * Feed source (frontend view)
 * Simplified version for UI display
 */
export interface FeedSource {
  /** Unique identifier */
  id: string;
  /** RSS feed URL */
  url: string;
  /** Display name */
  name: string;
  /** Provider type */
  provider: "direct" | "rsshub" | "cpproxy";
  /** Whether the source is active */
  enabled: boolean;
  /** Associated topics */
  topics: string[];
  /** Timestamp when added */
  addedAt: number;
  /** Last successful fetch timestamp */
  lastFetched?: number;
  /** Last fetch error message */
  fetchError?: string;
}

/**
 * Classified feed item
 * Result of AI classification on a feed item
 */
export interface ClassifiedFeedItem {
  /** Unique identifier */
  id: string;
  /** Item title */
  title: string;
  /** Extracted topics/tags */
  topics: string[];
  /** Relevance score (0-100) */
  relevanceScore: number;
  /** Human-readable explanation of relevance */
  explanation?: string;
  /** Classification confidence (0-1) */
  confidence?: number;
  /** Extracted keywords */
  keywords?: string[];
  /** Suggested action based on classification */
  suggestedAction?: string;
}

/**
 * Normalized RSS item
 * Standardized format after parsing RSS/Atom feeds
 */
export interface NormalizedRSSItem {
  /** Unique item ID (from guid, id, or URL) */
  id: string;
  /** Item title */
  title: string;
  /** Item content/description */
  content?: string;
  /** Item summary/excerpt */
  summary?: string;
  /** Item URL */
  url?: string;
  /** Author name */
  author?: string;
  /** Publication date */
  publishedAt?: Date;
  /** Last modified date */
  updatedAt?: Date;
  /** Item categories/tags */
  categories: string[];
  /** Enclosure (media attachment) URL */
  enclosureUrl?: string;
  /** Enclosure MIME type */
  enclosureType?: string;
  /** Source feed metadata */
  source: {
    name: string;
    url: string;
    iconUrl?: string;
  };
}

/**
 * Feed fetch result
 * Result of a feed fetch operation
 */
export interface FeedFetchResult {
  /** Whether the fetch succeeded */
  success: boolean;
  /** Feed source URL */
  sourceUrl: string;
  /** Number of items fetched */
  itemsFetched: number;
  /** Number of new items (after deduplication) */
  itemsNew: number;
  /** Error message if failed */
  error?: string;
  /** Fetch duration in milliseconds */
  fetchDurationMs: number;
  /** Timestamp of the fetch */
  timestamp: Date;
  /** Provider type used */
  providerType: string;
}

/**
 * Feed status tracking
 * Runtime status of a feed
 */
export interface FeedStatus {
  /** Last successful run timestamp */
  lastRunAt?: string;
  /** Next scheduled run timestamp */
  nextRunAt?: string;
  /** Last run status */
  lastRunStatus?: "success" | "error" | "running";
  /** Last run error message */
  lastError?: string;
  /** Total items processed in last run */
  lastRunItemCount?: number;
  /** Total items posted lifetime */
  totalItemsPosted?: number;
  /** When feed was manually triggered */
  triggerRequestedAt?: string;
  /** Current run ID if executing */
  currentRunId?: string;
}

/**
 * Feed execution payload
 * Job payload for feed workers
 */
export interface FeedExecutionPayload {
  /** Channel ID (feed channel) */
  channelId: string;
  /** User ID who owns the feed */
  userId: string;
  /** Workspace ID (if workspace-scoped) */
  workspaceId?: string;
  /** Feed configuration */
  config: RSSFeedConfig | ProactiveFeedConfig;
  /** Run ID for tracking */
  runId: string;
  /** Whether this was manually triggered */
  triggered?: boolean;
}

/**
 * Base feed configuration
 */
export interface BaseFeedConfig {
  /** Feed type discriminator */
  feedType: "rss" | "proactive";
  /** Whether feed is enabled */
  enabled: boolean;
  /** Schedule expression (cron) */
  schedule: string;
  /** Timezone for schedule evaluation */
  timezone: string;
  /** Maximum items per run */
  maxItemsPerRun: number;
  /** How long to track seen URLs (days) */
  dedupWindowDays: number;
  /** Minimum relevance score (0-100, 0 = include all) */
  minRelevanceScore: number;
  /** Post mode: individual or batch */
  postMode: "individual" | "batch";
  /** AI classification prompt override */
  classificationPrompt?: string;
}

/**
 * RSS feed configuration
 */
export interface RSSFeedConfig extends BaseFeedConfig {
  feedType: "rss";
  /** RSS feed sources */
  sources: Array<{
    url: string;
    name?: string;
    rsshubRoute?: string;
    headers?: Record<string, string>;
    iconUrl?: string;
  }>;
  /** RSSHub configuration */
  rsshubConfig?: {
    useCpProxy?: boolean;
    instanceUrl?: string;
    accessKey?: string;
  };
  /** Content extraction options */
  extraction?: {
    fetchFullContent?: boolean;
    maxContentLength?: number;
    includeMedia?: boolean;
  };
}

/**
 * Proactive feed configuration
 */
export interface ProactiveFeedConfig extends BaseFeedConfig {
  feedType: "proactive";
  /** What to include in the digest */
  include?: {
    tasksDue?: boolean;
    tasksDueDays?: number;
    pendingProposals?: boolean;
    recentEntities?: boolean;
    recentEntitiesHours?: number;
    recentCaptures?: boolean;
    recentCapturesHours?: number;
    activitySummary?: boolean;
  };
  /** AI summarization options */
  summarization?: {
    style?: "brief" | "detailed" | "bullet_points";
    maxItems?: number;
    includeInsights?: boolean;
  };
}

/**
 * Feed message metadata
 * Metadata attached to feed messages in channels
 */
export interface FeedMessageMetadata {
  /** Marker to identify feed items */
  feedItem: true;
  /** Feed type discriminator */
  feedType: "rss" | "proactive" | "automation";
  /** Source information */
  source: {
    platform: string;
    url: string;
    route?: string;
    author?: string;
    publishedAt?: string;
  };
  /** Topics/tags extracted from content */
  topics: string[];
  /** Alias for topics */
  categories: string[];
  /** Relevance score 0-1 */
  relevanceScore: number;
  /** Whether this was classified by AI */
  aiClassified: boolean;
  /** AI-generated summary */
  aiSummary?: string;
  /** Cross-feed references */
  crossFeeds: Array<{
    feedId: string;
    feedTitle: string;
    postedAt: string;
  }>;
  /** Batch info */
  batched?: boolean;
  batchId?: string;
  batchIndex?: number;
  batchTotal?: number;
  /** User interaction state */
  interaction?: {
    isCaptured: boolean;
    isDismissed: boolean;
    capturedAt?: string;
    dismissedAt?: string;
  };
  /** Engagement metrics from source */
  engagement?: {
    upvotes?: number;
    comments?: number;
    views?: number;
  };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for RSS feed config
 */
export function isRSSFeedConfig(
  config: BaseFeedConfig
): config is RSSFeedConfig {
  return config.feedType === "rss";
}

/**
 * Type guard for Proactive feed config
 */
export function isProactiveFeedConfig(
  config: BaseFeedConfig
): config is ProactiveFeedConfig {
  return config.feedType === "proactive";
}

/**
 * Type guard for feed message metadata
 */
export function isFeedMessageMetadata(
  metadata: unknown
): metadata is FeedMessageMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "feedItem" in metadata &&
    (metadata as FeedMessageMetadata).feedItem === true &&
    "feedType" in metadata &&
    "source" in metadata &&
    "topics" in metadata &&
    "relevanceScore" in metadata
  );
}

// ============================================================================
// Constants
// ============================================================================

export const FEED_CONSTANTS = {
  /** Default poll interval in minutes */
  DEFAULT_POLL_INTERVAL_MINUTES: 60,
  /** Minimum poll interval */
  MIN_POLL_INTERVAL_MINUTES: 5,
  /** Maximum poll interval (24 hours) */
  MAX_POLL_INTERVAL_MINUTES: 1440,
  /** Default fetch timeout in ms */
  DEFAULT_FETCH_TIMEOUT_MS: 30000,
  /** Default max items per fetch */
  DEFAULT_MAX_ITEMS: 100,
  /** Max feed name length */
  MAX_FEED_NAME_LENGTH: 255,
  /** Max feed description length */
  MAX_FEED_DESCRIPTION_LENGTH: 1000,
  /** Supported RSS versions */
  SUPPORTED_RSS_VERSIONS: ["0.90", "0.91", "0.92", "1.0", "2.0"],
  /** Supported Atom versions */
  SUPPORTED_ATOM_VERSIONS: ["0.3", "1.0"],
} as const;

// ============================================================================
// Re-export from @synap-core/types for convenience
// ============================================================================

export type {
  FeedConfig,
  RSSFeedConfig as CoreRSSFeedConfig,
  ProactiveFeedConfig as CoreProactiveFeedConfig,
  FeedStatus as CoreFeedStatus,
  FeedExecutionPayload as CoreFeedExecutionPayload,
  NormalizedRSSItem as CoreNormalizedRSSItem,
  RSSFetchResult,
  AggregatedData,
  FeedMessageMetadata as CoreFeedMessageMetadata,
} from "@synap-core/types";

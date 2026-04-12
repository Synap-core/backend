/**
 * Feed Types
 *
 * TypeScript interfaces for unified feeds (RSS and Proactive).
 * These are safe to import in browser builds (no zod/postgres dependency).
 *
 * For Zod schemas (validation), see @synap/api/types/feed-config
 */

// ── Feed Message Metadata ────────────────────────────────────────────────────

export interface FeedMessageMetadata {
  /** Source URL for RSS items */
  sourceUrl?: string;
  /** Original published date from source */
  publishedAt?: string;
  /** Author/publisher from source */
  author?: string;
  /** Relevance score from IS classification (0-100) */
  relevanceScore?: number;
  /** Categories/tags extracted from source */
  categories?: string[];
  /** Whether this was classified by AI */
  aiClassified?: boolean;
  /** Whether this was included in a batch digest */
  batched?: boolean;
  /** Batch ID if part of a digest */
  batchId?: string;
  /** Feed-specific metadata */
  feedType?: "rss" | "proactive";
  /** Original item ID from source */
  sourceItemId?: string;
}

// ── Base Feed Config ─────────────────────────────────────────────────────────

export interface BaseFeedConfig {
  /** Feed type discriminator */
  feedType: "rss" | "proactive";
  /** Whether feed is enabled */
  enabled: boolean;
  /** Schedule expression (cron or natural language) */
  schedule: string;
  /** Timezone for schedule evaluation */
  timezone: string;
  /** Maximum items per run */
  maxItemsPerRun: number;
  /** How long to track seen URLs (days) */
  dedupWindowDays: number;
  /** Minimum relevance score to include (0-100, 0 = include all) */
  minRelevanceScore: number;
  /** Whether to post items individually or as digest */
  postMode: "individual" | "batch";
  /** AI classification prompt override */
  classificationPrompt?: string;
}

// ── RSS Feed Config ──────────────────────────────────────────────────────────

export interface RSSFeedSource {
  /** RSS/Atom feed URL */
  url: string;
  /** Optional RSSHub route for CP proxy */
  rsshubRoute?: string;
  /** Custom headers for fetch */
  headers?: Record<string, string>;
  /** Source name override */
  name?: string;
  /** Source icon URL */
  iconUrl?: string;
}

export interface RSSFeedConfig extends BaseFeedConfig {
  feedType: "rss";
  /** RSS feed sources (primary + fallbacks) */
  sources: RSSFeedSource[];
  /** RSSHub configuration for CP proxy */
  rsshubConfig?: {
    /** Use CP RSSHub proxy instead of direct fetch */
    useCpProxy?: boolean;
    /** RSSHub instance URL (if not using CP) */
    instanceUrl?: string;
    /** Access key for RSSHub */
    accessKey?: string;
  };
  /** Content extraction options */
  extraction?: {
    /** Extract full article content */
    fetchFullContent?: boolean;
    /** Max content length */
    maxContentLength?: number;
    /** Include media attachments */
    includeMedia?: boolean;
  };
}

// ── Proactive Feed Config ────────────────────────────────────────────────────

export interface ProactiveFeedIncludeConfig {
  /** Include tasks due soon */
  tasksDue?: boolean;
  /** Days ahead to look for due tasks */
  tasksDueDays?: number;
  /** Include pending proposals */
  pendingProposals?: boolean;
  /** Include recently created entities */
  recentEntities?: boolean;
  /** Hours back to look for recent entities */
  recentEntitiesHours?: number;
  /** Include recent captures */
  recentCaptures?: boolean;
  /** Hours back to look for captures */
  recentCapturesHours?: number;
  /** Include workspace activity summary */
  activitySummary?: boolean;
}

export interface ProactiveFeedSummarizationConfig {
  /** Summarization style */
  style?: "brief" | "detailed" | "bullet_points";
  /** Max items to summarize */
  maxItems?: number;
  /** Include insights/suggestions */
  includeInsights?: boolean;
}

export interface ProactiveFeedConfig extends BaseFeedConfig {
  feedType: "proactive";
  /** What to include in the digest */
  include?: ProactiveFeedIncludeConfig;
  /** AI summarization options */
  summarization?: ProactiveFeedSummarizationConfig;
}

/** Union Feed Config type */
export type FeedConfig = RSSFeedConfig | ProactiveFeedConfig;

// ── Feed Status ──────────────────────────────────────────────────────────────

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

// ── Feed Execution Job Payloads ───────────────────────────────────────────────

export interface FeedExecutionPayload {
  /** Channel ID (feed channel) */
  channelId: string;
  /** User ID who owns the feed */
  userId: string;
  /** Workspace ID (if workspace-scoped) */
  workspaceId?: string;
  /** Feed configuration */
  config: FeedConfig;
  /** Run ID for tracking */
  runId: string;
  /** Whether this was manually triggered */
  triggered?: boolean;
}

// ── Normalized RSS Item (for fetchers) ───────────────────────────────────────

export interface NormalizedRSSItem {
  /** Unique identifier (guid or URL) */
  id: string;
  /** Item title */
  title: string;
  /** Item URL */
  url: string;
  /** Item content/summary */
  content: string;
  /** Plain text content (extracted) */
  contentText: string;
  /** Published date */
  publishedAt: Date;
  /** Author name */
  author?: string;
  /** Categories/tags */
  categories: string[];
  /** Source feed info */
  source: {
    name: string;
    url: string;
    iconUrl?: string;
  };
}

export interface RSSFetchResult {
  /** Successfully fetched and parsed items */
  items: NormalizedRSSItem[];
  /** Any errors that occurred */
  errors: Array<{ source: string; error: string }>;
  /** Total sources processed */
  sourceCount: number;
}

// ── Aggregated Data (for proactive feeds) ────────────────────────────────────

export interface AggregatedTask {
  id: string;
  title: string;
  dueDate: string;
  priority?: string;
  status?: string;
}

export interface AggregatedProposal {
  id: string;
  title: string;
  type: string;
  createdAt: Date;
}

export interface AggregatedEntity {
  id: string;
  type: string;
  title: string;
  createdAt: Date;
}

export interface AggregatedCapture {
  id: string;
  title: string;
  content?: string;
  url?: string;
  capturedAt: Date;
}

export interface ActivitySummary {
  entitiesCreated: number;
  entitiesUpdated: number;
  proposalsCreated: number;
  capturesCreated: number;
}

export interface AggregatedData {
  /** Tasks due within window */
  tasksDue: AggregatedTask[];
  /** Pending proposals */
  pendingProposals: AggregatedProposal[];
  /** Recently created entities */
  recentEntities: AggregatedEntity[];
  /** Recent captures */
  recentCaptures: AggregatedCapture[];
  /** Activity summary counts */
  activitySummary: ActivitySummary;
}

// ── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Type guard for RSS feed config.
 */
export function isRSSFeedConfig(config: FeedConfig): config is RSSFeedConfig {
  return config.feedType === "rss";
}

/**
 * Type guard for Proactive feed config.
 */
export function isProactiveFeedConfig(
  config: FeedConfig
): config is ProactiveFeedConfig {
  return config.feedType === "proactive";
}

/**
 * Get default RSS feed config.
 */
export function getDefaultRSSConfig(sources: RSSFeedSource[]): RSSFeedConfig {
  return {
    feedType: "rss",
    enabled: true,
    schedule: "0 */6 * * *",
    timezone: "UTC",
    maxItemsPerRun: 10,
    dedupWindowDays: 30,
    minRelevanceScore: 0,
    postMode: "individual",
    sources,
  };
}

/**
 * Get default proactive feed config.
 */
export function getDefaultProactiveConfig(): ProactiveFeedConfig {
  return {
    feedType: "proactive",
    enabled: true,
    schedule: "0 9 * * *", // 9 AM daily
    timezone: "UTC",
    maxItemsPerRun: 50,
    dedupWindowDays: 1,
    minRelevanceScore: 0,
    postMode: "batch",
    include: {
      tasksDue: true,
      tasksDueDays: 3,
      pendingProposals: true,
      recentEntities: true,
      recentEntitiesHours: 24,
      recentCaptures: true,
      recentCapturesHours: 24,
      activitySummary: true,
    },
    summarization: {
      style: "brief",
      maxItems: 10,
      includeInsights: true,
    },
  };
}

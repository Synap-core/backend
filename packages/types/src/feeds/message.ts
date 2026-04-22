/**
 * Feed Message Types
 *
 * TypeScript interfaces for feed message metadata.
 * These are safe to import in browser builds (no zod/postgres dependency).
 */

// ── Feed Message Metadata ────────────────────────────────────────────────────

export interface FeedMessageMetadata {
  /** Marker to identify feed items */
  feedItem: true;
  /** Feed type discriminator */
  feedType: "rss" | "proactive" | "automation";

  /** Source information */
  source: {
    /** Platform name: "hackernews", "reddit", "github" */
    platform: string;
    /** Original source URL */
    url: string;
    /** Original feed route or path */
    route?: string;
    /** Original author */
    author?: string;
    /** ISO timestamp when published */
    publishedAt?: string;
  };

  // AI processing (normalized)
  /** Topics/tags extracted from content: e.g., ["ai", "startups", "programming"] */
  topics: string[];
  /** Alias for topics (for compatibility) */
  categories: string[];
  /** Relevance score 0-1 (NOT 0-100 - normalize in backend if needed) */
  relevanceScore: number;
  /** Whether this was classified by AI */
  aiClassified: boolean;
  /** AI-generated summary of the content */
  aiSummary?: string;

  // Cross-feed references
  /** References to the same item in other feeds */
  crossFeeds: Array<{
    feedId: string;
    feedTitle: string;
    postedAt: string;
  }>;

  // Batch/digest info
  /** Whether this was included in a batch digest */
  batched?: boolean;
  /** Batch ID if part of a digest */
  batchId?: string;
  /** Index within the batch (0-based) */
  batchIndex?: number;
  /** Total items in the batch */
  batchTotal?: number;

  // User interactions
  /** User interaction state */
  interaction?: {
    /** Whether the user captured this item */
    isCaptured: boolean;
    /** Whether the user dismissed this item */
    isDismissed: boolean;
    /** When the item was captured */
    capturedAt?: string;
    /** When the item was dismissed */
    dismissedAt?: string;
  };

  // Engagement metrics from source
  /** Engagement metrics from the source platform */
  engagement?: {
    /** Number of upvotes/likes */
    upvotes?: number;
    /** Number of comments */
    comments?: number;
    /** Number of views */
    views?: number;
  };
}

// ── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Normalize relevance score to 0-1 range.
 * If score is 0-100, converts to 0-1.
 */
export function normalizeRelevanceScore(score: number): number {
  // If score is 0-100, convert to 0-1
  if (score > 1) return score / 100;
  return score;
}

/**
 * Type guard to check if metadata is a feed item.
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
    "relevanceScore" in metadata &&
    "aiClassified" in metadata &&
    "crossFeeds" in metadata
  );
}

/**
 * Create default feed message metadata with required fields.
 */
export function createFeedMessageMetadata(
  partial: Omit<FeedMessageMetadata, "feedItem" | "categories"> &
    Partial<Pick<FeedMessageMetadata, "categories">>
): FeedMessageMetadata {
  return {
    feedItem: true,
    categories: partial.categories ?? partial.topics ?? [],
    crossFeeds: partial.crossFeeds ?? [],
    feedType: partial.feedType,
    source: partial.source,
    topics: partial.topics,
    relevanceScore: partial.relevanceScore,
    aiClassified: partial.aiClassified,
    aiSummary: partial.aiSummary,
    batched: partial.batched,
    batchId: partial.batchId,
    batchIndex: partial.batchIndex,
    batchTotal: partial.batchTotal,
    interaction: partial.interaction,
    engagement: partial.engagement,
  };
}

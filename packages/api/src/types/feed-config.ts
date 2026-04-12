/**
 * Feed Config Types - Zod Schemas
 *
 * Unified feed configuration for RSS and Proactive feeds.
 * Stored in channel.config JSONB field for FEED type channels.
 *
 * Note: TypeScript interfaces are in @synap-core/types/feeds
 */

import { z } from "zod";
import type {
  FeedConfig,
  RSSFeedConfig,
  ProactiveFeedConfig,
  RSSFeedSource,
  FeedMessageMetadata,
} from "@synap-core/types";

// Re-export types from @synap-core/types
export type {
  FeedConfig,
  RSSFeedConfig,
  ProactiveFeedConfig,
  RSSFeedSource,
  FeedMessageMetadata,
  FeedExecutionPayload,
  FeedStatus,
  NormalizedRSSItem,
  RSSFetchResult,
  AggregatedData,
} from "@synap-core/types";

// ── Feed Message Metadata ────────────────────────────────────────────────────

export const FeedMessageMetadataSchema: z.ZodType<FeedMessageMetadata> =
  z.object({
    /** Source URL for RSS items */
    sourceUrl: z.string().url().optional(),
    /** Original published date from source */
    publishedAt: z.string().datetime().optional(),
    /** Author/publisher from source */
    author: z.string().optional(),
    /** Relevance score from IS classification (0-100) */
    relevanceScore: z.number().min(0).max(100).optional(),
    /** Categories/tags extracted from source */
    categories: z.array(z.string()).optional(),
    /** Whether this was classified by AI */
    aiClassified: z.boolean().optional(),
    /** Whether this was included in a batch digest */
    batched: z.boolean().optional(),
    /** Batch ID if part of a digest */
    batchId: z.string().uuid().optional(),
    /** Feed-specific metadata */
    feedType: z.enum(["rss", "proactive"]).optional(),
    /** Original item ID from source */
    sourceItemId: z.string().optional(),
  });

// ── Base Feed Config ─────────────────────────────────────────────────────────

export const BaseFeedConfigSchema = z.object({
  /** Feed type discriminator */
  feedType: z.enum(["rss", "proactive"]),
  /** Whether feed is enabled */
  enabled: z.boolean().default(true),
  /** Schedule expression (cron or natural language) */
  schedule: z.string().default("0 */6 * * *"), // Every 6 hours default
  /** Timezone for schedule evaluation */
  timezone: z.string().default("UTC"),
  /** Maximum items per run */
  maxItemsPerRun: z.number().int().min(1).max(100).default(10),
  /** How long to track seen URLs (days) */
  dedupWindowDays: z.number().int().min(1).max(90).default(30),
  /** Minimum relevance score to include (0-100, 0 = include all) */
  minRelevanceScore: z.number().int().min(0).max(100).default(0),
  /** Whether to post items individually or as digest */
  postMode: z.enum(["individual", "batch"]).default("individual"),
  /** AI classification prompt override */
  classificationPrompt: z.string().optional(),
});

// ── RSS Feed Config ──────────────────────────────────────────────────────────

export const RSSFeedSourceSchema: z.ZodType<RSSFeedSource> = z.object({
  /** RSS/Atom feed URL */
  url: z.string().url(),
  /** Optional RSSHub route for CP proxy */
  rsshubRoute: z.string().optional(),
  /** Custom headers for fetch */
  headers: z.record(z.string(), z.string()).optional(),
  /** Source name override */
  name: z.string().optional(),
  /** Source icon URL */
  iconUrl: z.string().url().optional(),
});

export const RSSFeedConfigSchema: z.ZodType<RSSFeedConfig> =
  BaseFeedConfigSchema.extend({
    feedType: z.literal("rss"),
    /** RSS feed sources (primary + fallbacks) */
    sources: z
      .array(RSSFeedSourceSchema)
      .min(1, "At least one RSS source is required"),
    /** RSSHub configuration for CP proxy */
    rsshubConfig: z
      .object({
        /** Use CP RSSHub proxy instead of direct fetch */
        useCpProxy: z.boolean().default(true),
        /** RSSHub instance URL (if not using CP) */
        instanceUrl: z.string().url().optional(),
        /** Access key for RSSHub */
        accessKey: z.string().optional(),
      })
      .optional(),
    /** Content extraction options */
    extraction: z
      .object({
        /** Extract full article content */
        fetchFullContent: z.boolean().default(false),
        /** Max content length */
        maxContentLength: z.number().int().default(5000),
        /** Include media attachments */
        includeMedia: z.boolean().default(false),
      })
      .optional(),
  });

// ── Proactive Feed Config ────────────────────────────────────────────────────

export const ProactiveFeedConfigSchema: z.ZodType<ProactiveFeedConfig> =
  BaseFeedConfigSchema.extend({
    feedType: z.literal("proactive"),
    /** What to include in the digest */
    include: z
      .object({
        /** Include tasks due soon */
        tasksDue: z.boolean().default(true),
        /** Days ahead to look for due tasks */
        tasksDueDays: z.number().int().min(1).max(30).default(3),
        /** Include pending proposals */
        pendingProposals: z.boolean().default(true),
        /** Include recently created entities */
        recentEntities: z.boolean().default(true),
        /** Hours back to look for recent entities */
        recentEntitiesHours: z.number().int().min(1).max(168).default(24),
        /** Include recent captures */
        recentCaptures: z.boolean().default(true),
        /** Hours back to look for captures */
        recentCapturesHours: z.number().int().min(1).max(168).default(24),
        /** Include workspace activity summary */
        activitySummary: z.boolean().default(true),
      })
      .optional(),
    /** AI summarization options */
    summarization: z
      .object({
        /** Summarization style */
        style: z.enum(["brief", "detailed", "bullet_points"]).default("brief"),
        /** Max items to summarize */
        maxItems: z.number().int().min(1).max(50).default(10),
        /** Include insights/suggestions */
        includeInsights: z.boolean().default(true),
      })
      .optional(),
  });

// ── Union Feed Config ────────────────────────────────────────────────────────

export const FeedConfigSchema: z.ZodType<FeedConfig> = z.discriminatedUnion(
  "feedType",
  [RSSFeedConfigSchema, ProactiveFeedConfigSchema]
);

// ── Feed Status ──────────────────────────────────────────────────────────────

export const FeedStatusSchema: z.ZodType<FeedStatus> = z.object({
  /** Last successful run timestamp */
  lastRunAt: z.string().datetime().optional(),
  /** Next scheduled run timestamp */
  nextRunAt: z.string().datetime().optional(),
  /** Last run status */
  lastRunStatus: z.enum(["success", "error", "running"]).optional(),
  /** Last run error message */
  lastError: z.string().optional(),
  /** Total items processed in last run */
  lastRunItemCount: z.number().int().optional(),
  /** Total items posted lifetime */
  totalItemsPosted: z.number().int().default(0),
  /** When feed was manually triggered */
  triggerRequestedAt: z.string().datetime().optional(),
  /** Current run ID if executing */
  currentRunId: z.string().uuid().optional(),
});

// ── Feed Execution Job Payloads ───────────────────────────────────────────────

export const FeedExecutionPayloadSchema: z.ZodType<FeedExecutionPayload> =
  z.object({
    /** Channel ID (feed channel) */
    channelId: z.string().uuid(),
    /** User ID who owns the feed */
    userId: z.string(),
    /** Workspace ID (if workspace-scoped) */
    workspaceId: z.string().uuid().optional(),
    /** Feed configuration */
    config: FeedConfigSchema,
    /** Run ID for tracking */
    runId: z.string().uuid(),
    /** Whether this was manually triggered */
    triggered: z.boolean().default(false),
  });

// ── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Parse and validate feed config from JSONB.
 */
export function parseFeedConfig(data: unknown): FeedConfig | null {
  const result = FeedConfigSchema.safeParse(data);
  return result.success ? result.data : null;
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

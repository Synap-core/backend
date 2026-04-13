/**
 * Feed Types
 *
 * Type definitions and Zod schemas for RSS/Atom feed integrations
 * and proactive AI feed configurations.
 */

import { z } from "zod";

// ============================================================================
// Feed Types
// ============================================================================

export type FeedType = "rss" | "atom" | "json" | "proactive";

export interface FeedConfig {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  type: FeedType;
  /** Alias for type - used in worker payloads */
  feedType?: FeedType;
  url: string;
  isActive: boolean;
  pollIntervalMinutes: number;
  lastFetchedAt?: Date;
  lastFetchStatus?: "success" | "error" | "pending";
  lastFetchError?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface RSSFeedSource {
  url: string;
  name?: string;
}

export interface RSSFeedConfig extends FeedConfig {
  type: "rss" | "atom";
  feedTitle?: string;
  feedDescription?: string;
  feedLink?: string;
  itemCount?: number;
  // Additional fields for feed workers
  feedType?: "rss" | "atom";
  sources?: RSSFeedSource[];
  rsshubConfig?: { useCpProxy?: boolean };
  enabled?: boolean;
  schedule?: string;
  timezone?: string;
  maxItemsPerRun?: number;
  dedupWindowDays?: number;
  minRelevanceScore?: number;
  postMode?: "individual" | "batch";
}

export interface ProactiveFeedConfig extends FeedConfig {
  type: "proactive";
  intelligenceServiceId?: string;
  agentType?: string;
  nudgeDensity?: "low" | "medium" | "high";
  categories?: string[];
  // Additional fields for feed workers
  feedType?: "proactive";
  enabled?: boolean;
  schedule?: string;
  timezone?: string;
  maxItemsPerRun?: number;
  dedupWindowDays?: number;
  minRelevanceScore?: number;
  postMode?: "individual" | "batch";
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
  summarization?: {
    style?: "brief" | "detailed";
    maxItems?: number;
    includeInsights?: boolean;
  };
}

// ============================================================================
// Feed Execution Types
// ============================================================================

export interface FeedExecutionPayload {
  channelId: string;
  userId: string;
  workspaceId?: string;
  runId: string;
  config: RSSFeedConfig | ProactiveFeedConfig | FeedConfig;
  force?: boolean;
}

// ============================================================================
// Feed Message Types
// ============================================================================

export interface FeedMessageMetadata {
  feedId?: string;
  feedName?: string;
  feedType?: FeedType;
  originalUrl?: string;
  publishedAt?: Date;
  author?: string;
  categories?: string[];
  guid?: string;
  isRead?: boolean;
  isStarred?: boolean;
  // Additional fields for feed workers
  sourceItemId?: string;
  sourceUrl?: string;
  topics?: string[];
  relevanceScore?: number;
  aiClassified?: boolean;
  crossFeeds?: string[];
  batched?: boolean;
  batchId?: string;
  batchIndex?: number;
  totalInBatch?: number;
  feedRunId?: string;
  itemCount?: number;
}

export interface FeedMessage {
  id: string;
  feedId: string;
  workspaceId: string;
  title: string;
  content?: string;
  summary?: string;
  url?: string;
  metadata: FeedMessageMetadata;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Feed Fetch Result Types
// ============================================================================

export interface FeedFetchResult {
  success: boolean;
  feedId: string;
  itemsFetched: number;
  itemsNew: number;
  error?: string;
  fetchDurationMs: number;
  timestamp: Date;
}

export interface FeedFetchOptions {
  force?: boolean;
  timeoutMs?: number;
  maxItems?: number;
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const FeedTypeSchema = z.enum(["rss", "atom", "json", "proactive"]);

export const FeedConfigSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  type: FeedTypeSchema,
  url: z.string().url(),
  isActive: z.boolean().default(true),
  pollIntervalMinutes: z.number().int().min(5).max(1440).default(60),
  lastFetchedAt: z.date().optional(),
  lastFetchStatus: z.enum(["success", "error", "pending"]).optional(),
  lastFetchError: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const RSSFeedConfigSchema = FeedConfigSchema.extend({
  type: z.enum(["rss", "atom"]),
  feedTitle: z.string().optional(),
  feedDescription: z.string().optional(),
  feedLink: z.string().url().optional(),
  itemCount: z.number().int().optional(),
});

export const ProactiveFeedConfigSchema = FeedConfigSchema.extend({
  type: z.literal("proactive"),
  intelligenceServiceId: z.string().optional(),
  agentType: z.string().optional(),
  nudgeDensity: z.enum(["low", "medium", "high"]).optional(),
  categories: z.array(z.string()).optional(),
});

export const FeedMessageMetadataSchema = z.object({
  feedId: z.string(),
  feedName: z.string(),
  feedType: FeedTypeSchema,
  originalUrl: z.string().url().optional(),
  publishedAt: z.date().optional(),
  author: z.string().optional(),
  categories: z.array(z.string()).optional(),
  guid: z.string().optional(),
  isRead: z.boolean().default(false),
  isStarred: z.boolean().default(false),
});

export const FeedMessageSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  content: z.string().optional(),
  summary: z.string().optional(),
  url: z.string().url().optional(),
  metadata: FeedMessageMetadataSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const FeedFetchResultSchema = z.object({
  success: z.boolean(),
  feedId: z.string(),
  itemsFetched: z.number().int().min(0),
  itemsNew: z.number().int().min(0),
  error: z.string().optional(),
  fetchDurationMs: z.number().int().min(0),
  timestamp: z.date(),
});

export const FeedFetchOptionsSchema = z.object({
  force: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  maxItems: z.number().int().min(1).max(1000).optional(),
});

// ============================================================================
// Input Schemas (for API operations)
// ============================================================================

export const CreateFeedInputSchema = z.object({
  workspaceId: z.string(),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  type: FeedTypeSchema,
  url: z.string().url(),
  isActive: z.boolean().optional().default(true),
  pollIntervalMinutes: z.number().int().min(5).max(1440).optional().default(60),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Proactive feed specific
  intelligenceServiceId: z.string().optional(),
  agentType: z.string().optional(),
  nudgeDensity: z.enum(["low", "medium", "high"]).optional(),
  categories: z.array(z.string()).optional(),
});

export const UpdateFeedInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  url: z.string().url().optional(),
  isActive: z.boolean().optional(),
  pollIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  nudgeDensity: z.enum(["low", "medium", "high"]).optional(),
  categories: z.array(z.string()).optional(),
});

export const FetchFeedInputSchema = z.object({
  feedId: z.string(),
  options: FeedFetchOptionsSchema.optional(),
});

// ============================================================================
// Type exports from schemas
// ============================================================================

export type CreateFeedInput = z.infer<typeof CreateFeedInputSchema>;
export type UpdateFeedInput = z.infer<typeof UpdateFeedInputSchema>;
export type FetchFeedInput = z.infer<typeof FetchFeedInputSchema>;

// ============================================================================
// Feed Constants
// ============================================================================

export const FEED_CONSTANTS = {
  DEFAULT_POLL_INTERVAL_MINUTES: 60,
  MIN_POLL_INTERVAL_MINUTES: 5,
  MAX_POLL_INTERVAL_MINUTES: 1440, // 24 hours
  DEFAULT_FETCH_TIMEOUT_MS: 30000,
  DEFAULT_MAX_ITEMS: 100,
  MAX_FEED_NAME_LENGTH: 255,
  MAX_FEED_DESCRIPTION_LENGTH: 1000,
  SUPPORTED_RSS_VERSIONS: ["0.90", "0.91", "0.92", "1.0", "2.0"],
  SUPPORTED_ATOM_VERSIONS: ["0.3", "1.0"],
} as const;

// ============================================================================
// Feed Error Types
// ============================================================================

export class FeedError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly feedId?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "FeedError";
  }
}

export class FeedFetchError extends FeedError {
  constructor(
    message: string,
    feedId: string,
    public readonly statusCode?: number,
    cause?: Error
  ) {
    super(message, "FETCH_ERROR", feedId, cause);
    this.name = "FeedFetchError";
  }
}

export class FeedParseError extends FeedError {
  constructor(message: string, feedId: string, cause?: Error) {
    super(message, "PARSE_ERROR", feedId, cause);
    this.name = "FeedParseError";
  }
}

export class FeedValidationError extends FeedError {
  constructor(message: string, cause?: Error) {
    super(message, "VALIDATION_ERROR", undefined, cause);
    this.name = "FeedValidationError";
  }
}

// ============================================================================
// Feed Helper Functions (moved from @synap/api to break circular dependency)
// ============================================================================

import { parseExpression } from "cron-parser";

/**
 * Calculate next run time based on cron expression.
 * Uses cron-parser for reliable parsing.
 */
export function calculateNextRun(cron: string, timezone: string): Date {
  try {
    const interval = parseExpression(cron, {
      tz: timezone,
      currentDate: new Date(),
    });
    return interval.next().toDate();
  } catch (error) {
    // Fallback: run in 1 hour if cron is invalid
    return new Date(Date.now() + 60 * 60 * 1000);
  }
}

/**
 * Check if a feed is due for execution.
 */
export function isFeedDue(nextRunAt: string | null | undefined): boolean {
  if (!nextRunAt) return true;
  return new Date(nextRunAt) <= new Date();
}

/**
 * Feed Types
 *
 * Type definitions and Zod schemas for RSS/Atom feed integrations
 * and proactive AI feed configurations.
 *
 * NOTE: FeedMessageMetadata is now defined in @synap-core/types/feeds.
 * This file re-exports it for backward compatibility.
 *
 * TYPE SYNCHRONIZATION:
 * This file maintains compatibility with:
 * - @synap-core/types (canonical source)
 * - @synap/feed-service (service-specific)
 * - synap-intelligence-service (IS classification)
 * - relay-app (frontend)
 *
 * @module feed-types
 */

import { z } from "zod";
import type { FeedMessageMetadata } from "@synap-core/types/feeds";

// Re-export the canonical type from @synap-core/types
export type { FeedMessageMetadata };

// Re-export synchronized types from feed-types-sync
export type {
  FeedProviderConfig,
  FeedSourceConfig,
  FeedPreferences,
  FeedSource,
  ClassifiedFeedItem,
  NormalizedRSSItem,
  FeedFetchResult,
  FeedStatus,
  FeedExecutionPayload,
  BaseFeedConfig,
} from "./feed-types-sync.js";

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

// Note: FeedExecutionPayload is now re-exported from feed-types-sync

// ============================================================================
// Feed Message Types
// ============================================================================

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

// Note: FeedFetchResult is now re-exported from feed-types-sync

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

// Note: FeedMessageMetadataSchema removed - use type guards from @synap-core/types/feeds

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

export const FeedFetchOptionsSchema = z.object({
  force: z.boolean().optional(),
  maxItems: z.number().optional(),
  timeout: z.number().optional(),
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

import cronParser from "cron-parser";
const { parseExpression } = cronParser;

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

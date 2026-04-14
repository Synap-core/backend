/**
 * Feed Service Types
 *
 * Core type definitions for the RSS/Atom feed ingestion pipeline.
 * Extends shared types from @synap/shared-utils with service-specific types.
 */

import type { z } from "zod";
import type {
  RSSProviderConfigSchema,
  FeedSourceConfigSchema,
  NormalizedRSSItemSchema,
  ClassifiedItemSchema,
  UserContextSchema,
  FeedFetchResultSchema,
  FeedHealthStatusSchema,
} from "../config/FeedConfig.js";

// ============================================================================
// Configuration Types
// ============================================================================

/** RSS provider configuration variant */
export type RSSProviderConfig = z.infer<typeof RSSProviderConfigSchema>;

/** Feed source configuration with provider-specific settings */
export type FeedSourceConfig = z.infer<typeof FeedSourceConfigSchema>;

// ============================================================================
// Feed Item Types
// ============================================================================

/** Normalized RSS/Atom/JSON feed item after parsing */
export type NormalizedRSSItem = z.infer<typeof NormalizedRSSItemSchema>;

/** Feed item with classification metadata */
export type ClassifiedItem = z.infer<typeof ClassifiedItemSchema>;

/** User context for personalization */
export type UserContext = z.infer<typeof UserContextSchema>;

// ============================================================================
// Feed Result Types
// ============================================================================

/** Result of a feed fetch operation */
export type FeedFetchResult = z.infer<typeof FeedFetchResultSchema>;

/** Health status of a feed provider */
export type FeedHealthStatus = z.infer<typeof FeedHealthStatusSchema>;

// ============================================================================
// Classification Types
// ============================================================================

/** Classification result from an IS classifier */
export interface ISClassificationResult {
  /** Classification category/topic */
  category: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Relevance score for the user (0-1) */
  relevanceScore?: number;
  /** Extracted keywords */
  keywords?: string[];
  /** Suggested action */
  suggestedAction?: string;
}

/** Classification request payload for IS API */
export interface ISClassificationRequest {
  /** Items to classify */
  items: Array<{
    id: string;
    title: string;
    content?: string;
    url?: string;
    publishedAt?: Date;
  }>;
  /** User context for personalization */
  context?: UserContext;
  /** Classification options */
  options?: {
    extractKeywords?: boolean;
    calculateRelevance?: boolean;
    maxCategories?: number;
  };
}

// ============================================================================
// Provider Types
// ============================================================================

/** Provider capability flags */
export interface ProviderCapabilities {
  /** Supports pagination */
  supportsPagination: boolean;
  /** Supports filtering */
  supportsFiltering: boolean;
  /** Supports authentication */
  supportsAuth: boolean;
  /** Supports custom headers */
  supportsCustomHeaders: boolean;
  /** Supports JSON feeds */
  supportsJson: boolean;
  /** Supports RSS feeds */
  supportsRss: boolean;
  /** Supports Atom feeds */
  supportsAtom: boolean;
}

/** Feed provider metadata */
export interface FeedProviderInfo {
  /** Provider type identifier */
  type: string;
  /** Human-readable name */
  displayName: string;
  /** Provider description */
  description: string;
  /** Provider capabilities */
  capabilities: ProviderCapabilities;
  /** Default configuration values */
  defaults: Partial<RSSProviderConfig>;
}

// ============================================================================
// Scheduler Types
// ============================================================================

/** Scheduled feed job */
export interface ScheduledFeedJob {
  /** Unique job ID */
  id: string;
  /** Feed configuration ID */
  feedConfigId: string;
  /** Next scheduled run time */
  nextRunAt: Date;
  /** Cron expression for recurrence */
  schedule: string;
  /** Timezone for scheduling */
  timezone: string;
  /** Whether the job is active */
  isActive: boolean;
  /** Last run result */
  lastRunResult?: FeedFetchResult;
  /** Created timestamp */
  createdAt: Date;
  /** Updated timestamp */
  updatedAt: Date;
}

/** Scheduler configuration */
export interface SchedulerConfig {
  /** Default poll interval in minutes */
  defaultPollIntervalMinutes: number;
  /** Maximum concurrent fetches */
  maxConcurrentFetches: number;
  /** Enable job persistence */
  enablePersistence: boolean;
  /** Retry configuration */
  retry: {
    maxAttempts: number;
    backoffMs: number;
    maxBackoffMs: number;
  };
}

// ============================================================================
// Publisher Types
// ============================================================================

/** Message publisher configuration */
export interface PublisherConfig {
  /** Publisher type */
  type: "channel" | "webhook" | "queue";
  /** Batch posting mode */
  postMode: "individual" | "batch";
  /** Maximum items per batch */
  maxBatchSize?: number;
  /** Rate limit (items per minute) */
  rateLimitPerMinute?: number;
  /** Enable deduplication */
  enableDeduplication: boolean;
  /** Deduplication window in hours */
  dedupWindowHours: number;
}

/** Published message metadata */
export interface PublishedMessageMetadata {
  /** Original feed item ID */
  feedItemId: string;
  /** Source feed URL */
  sourceUrl: string;
  /** Source feed name */
  sourceName?: string;
  /** Classification category */
  category?: string;
  /** Relevance score */
  relevanceScore?: number;
  /** Published timestamp from source */
  originalPublishedAt?: Date;
  /** Fetch timestamp */
  fetchedAt: Date;
}

// ============================================================================
// Repository Types
// ============================================================================

/** Query options for feed repository */
export interface FeedRepositoryQuery {
  /** Filter by workspace */
  workspaceId?: string;
  /** Filter by active status */
  isActive?: boolean;
  /** Filter by feed type */
  type?: string;
  /** Pagination cursor */
  cursor?: string;
  /** Page size */
  limit?: number;
  /** Order by field */
  orderBy?: "createdAt" | "updatedAt" | "lastFetchedAt" | "name";
  /** Sort direction */
  sortDirection?: "asc" | "desc";
}

/** Feed statistics */
export interface FeedStatistics {
  /** Total items fetched */
  totalItemsFetched: number;
  /** Total items published */
  totalItemsPublished: number;
  /** Average fetch duration in ms */
  averageFetchDurationMs: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Last successful fetch */
  lastSuccessfulFetch?: Date;
  /** Last error */
  lastError?: string;
  /** Error count in last 24h */
  errorCount24h: number;
}

// ============================================================================
// Keyword Classification Types
// ============================================================================

/** Keyword category definitions */
export interface KeywordCategory {
  /** Category name */
  name: string;
  /** Primary keywords (high weight) */
  keywords: string[];
  /** Related keywords (medium weight) */
  relatedKeywords?: string[];
  /** Exclusion keywords (negative weight) */
  exclusionKeywords?: string[];
}

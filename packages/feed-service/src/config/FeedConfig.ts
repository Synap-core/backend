/**
 * Feed Configuration
 *
 * Zod schemas and configuration constants for the feed service.
 * Provides runtime validation for all feed-related configurations.
 */

import { z } from "zod";

// ============================================================================
// Provider Type Schemas
// ============================================================================

/** Valid RSS provider types */
export const ProviderTypeSchema = z.enum(["custom", "direct"]);

/** Valid feed parser types */
export const ParserTypeSchema = z.enum(["rss", "atom", "json"]);

/** Valid classifier types */
export const ClassifierTypeSchema = z.enum(["is", "keyword", "noop"]);

/** Valid publisher types */
export const PublisherTypeSchema = z.enum(["channel"]);

// ============================================================================
// RSS Provider Configuration Schema
// ============================================================================

/**
 * RSS provider configuration schema
 *
 * Validates provider-specific settings for fetching RSS/Atom feeds.
 */
export const RSSProviderConfigSchema = z.object({
  /** Provider type - determines fetching strategy */
  type: ProviderTypeSchema,
  /** Base URL for the provider */
  url: z.string().url().optional(),
  /** API key for authenticated providers */
  apiKey: z.string().optional(),
  /** Request timeout in milliseconds */
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
  /** Number of retry attempts */
  retryAttempts: z.number().int().min(0).max(10).optional(),
  /** Custom headers for requests */
  headers: z.record(z.string(), z.string()).optional(),
});

// ============================================================================
// Feed Source Configuration Schema
// ============================================================================

/**
 * Feed source configuration schema
 *
 * Defines a complete feed source with provider and parsing settings.
 */
export const FeedSourceConfigSchema = z.object({
  /** Feed URL to fetch from */
  url: z.string().url(),
  /** Provider configuration for fetching */
  provider: RSSProviderConfigSchema,
  /** Parser type - auto-detected if not specified */
  parser: ParserTypeSchema.optional(),
  /** Custom headers for this specific feed */
  headers: z.record(z.string(), z.string()).optional(),
  /** Human-readable feed name */
  name: z.string().min(1).max(255).optional(),
  /** Feed icon URL */
  iconUrl: z.string().url().optional(),
});

// ============================================================================
// Feed Item Schemas
// ============================================================================

/**
 * Source reference schema
 */
const FeedSourceReferenceSchema = z.object({
  title: z.string().optional(),
  url: z.string().url(),
  name: z.string().optional(),
});

/**
 * Normalized RSS item schema
 *
 * Represents a feed item after parsing and normalization.
 */
export const NormalizedRSSItemSchema = z.object({
  /** Unique item ID (from guid, id, or URL) */
  id: z.string(),
  /** Item title */
  title: z.string(),
  /** Item content/description */
  content: z.string().optional(),
  /** Item summary/excerpt */
  summary: z.string().optional(),
  /** Item URL */
  url: z.string().url().optional(),
  /** Author name */
  author: z.string().optional(),
  /** Publication date */
  publishedAt: z.date().optional(),
  /** Last modified date */
  updatedAt: z.date().optional(),
  /** Item categories/tags */
  categories: z.array(z.string()).default([]),
  /** Enclosure (media attachment) URL */
  enclosureUrl: z.string().url().optional(),
  /** Enclosure MIME type */
  enclosureType: z.string().optional(),
  /** Source feed metadata */
  source: FeedSourceReferenceSchema,
});

/**
 * Classified item schema
 *
 * Represents a feed item with classification metadata.
 */
export const ClassifiedItemSchema = z.object({
  /** Original normalized item */
  item: NormalizedRSSItemSchema,
  /** Classification category */
  category: z.string(),
  /** Classification confidence (0-1) */
  confidence: z.number().min(0).max(1),
  /** Relevance score for the user (0-1) */
  relevanceScore: z.number().min(0).max(1).optional(),
  /** Extracted keywords */
  keywords: z.array(z.string()).default([]),
  /** Suggested action based on classification */
  suggestedAction: z.string().optional(),
  /** Whether the item should be published */
  shouldPublish: z.boolean().default(true),
});

/**
 * User context schema for personalization
 */
export const UserContextSchema = z.object({
  /** User ID */
  userId: z.string(),
  /** Workspace ID */
  workspaceId: z.string().optional(),
  /** User's interests/topics */
  interests: z.array(z.string()).default([]),
  /** Keywords to prioritize */
  priorityKeywords: z.array(z.string()).default([]),
  /** Keywords to exclude */
  excludeKeywords: z.array(z.string()).default([]),
  /** Preferred content categories */
  preferredCategories: z.array(z.string()).default([]),
  /** Historical relevance scores for calibration */
  calibrationScores: z.record(z.string(), z.number()).optional(),
});

// ============================================================================
// Result Schemas
// ============================================================================

/**
 * Feed fetch result schema
 */
export const FeedFetchResultSchema = z.object({
  /** Whether the fetch succeeded */
  success: z.boolean(),
  /** Feed source URL */
  sourceUrl: z.string(),
  /** Number of items fetched */
  itemsFetched: z.number().int().min(0),
  /** Number of new items (after deduplication) */
  itemsNew: z.number().int().min(0),
  /** Error message if failed */
  error: z.string().optional(),
  /** Fetch duration in milliseconds */
  fetchDurationMs: z.number().int().min(0),
  /** Timestamp of the fetch */
  timestamp: z.date(),
  /** Provider type used */
  providerType: z.string(),
});

/**
 * Feed health status schema
 */
export const FeedHealthStatusSchema = z.object({
  /** Whether the provider is healthy */
  healthy: z.boolean(),
  /** Provider type */
  providerType: z.string(),
  /** Last successful fetch timestamp */
  lastSuccessfulFetch: z.date().optional(),
  /** Last error message */
  lastError: z.string().optional(),
  /** Consecutive failure count */
  consecutiveFailures: z.number().int().min(0).default(0),
  /** Average response time in ms */
  averageResponseTimeMs: z.number().int().min(0).optional(),
  /** Health check timestamp */
  checkedAt: z.date(),
});

// ============================================================================
// Nested Config Schemas
// ============================================================================

const FetchConfigSchema = z.object({
  /** Maximum items per fetch */
  maxItemsPerFetch: z.number().int().min(1).max(1000).default(100),
  /** Default timeout in ms */
  defaultTimeoutMs: z.number().int().min(1000).max(300000).default(30000),
  /** Maximum concurrent fetches */
  maxConcurrentFetches: z.number().int().min(1).max(50).default(10),
  /** User agent string */
  userAgent: z.string().default("SynapFeedService/1.0"),
});

const ClassificationConfigSchema = z.object({
  /** Minimum confidence threshold */
  minConfidence: z.number().min(0).max(1).default(0.5),
  /** Minimum relevance score */
  minRelevanceScore: z.number().min(0).max(1).default(0.3),
  /** IS service URL */
  isServiceUrl: z.string().url().optional(),
  /** IS service API key */
  isServiceApiKey: z.string().optional(),
});

const PublishingConfigSchema = z.object({
  /** Batch size for publishing */
  batchSize: z.number().int().min(1).max(100).default(10),
  /** Rate limit per minute */
  rateLimitPerMinute: z.number().int().min(1).max(1000).default(60),
  /** Enable deduplication */
  enableDeduplication: z.boolean().default(true),
  /** Deduplication window in hours */
  dedupWindowHours: z.number().int().min(1).max(720).default(24),
});

// ============================================================================
// Service Configuration
// ============================================================================

/**
 * Feed service configuration schema
 *
 * Top-level configuration for the feed service.
 */
export const FeedServiceConfigSchema = z.object({
  /** Default provider configuration */
  defaultProvider: RSSProviderConfigSchema.default({ type: "custom" }),
  /** Default classifier type */
  defaultClassifier: ClassifierTypeSchema.default("keyword"),
  /** Default publisher type */
  defaultPublisher: PublisherTypeSchema.default("channel"),
  /** Fetching configuration */
  fetch: FetchConfigSchema,
  /** Classification configuration */
  classification: ClassificationConfigSchema,
  /** Publishing configuration */
  publishing: PublishingConfigSchema,
});

// ============================================================================
// Type Exports
// ============================================================================

export type RSSProviderConfig = z.infer<typeof RSSProviderConfigSchema>;
export type FeedServiceConfig = z.infer<typeof FeedServiceConfigSchema>;

/**
 * @synap/feed-service
 *
 * RSS/Atom feed ingestion service for Synap.
 * Provides a modular pipeline for fetching, classifying, and publishing feed content.
 *
 * @example
 * ```typescript
 * import { FeedService, FeedServiceFactory } from "@synap/feed-service";
 *
 * // Create service
 * const feedService = new FeedService({
 *   defaultClassifier: "keyword",
 *   enableDeduplication: true
 * });
 *
 * // Process a feed
 * const result = await feedService.processFeed(
 *   {
 *     url: "https://example.com/feed.xml",
 *     provider: { type: "direct" }
 *   },
 *   {
 *     destination: { channelId: "channel-123", userId: "user-456" },
 *     userContext: { userId: "user-456", interests: ["technology"] }
 *   }
 * );
 * ```
 */

// ============================================================================
// Core Service
// ============================================================================

export { FeedService } from "./FeedService.js";
export type {
  FeedServiceConfiguration,
  FeedProcessingOptions,
  FeedProcessingResult,
} from "./FeedService.js";

// ============================================================================
// Factory
// ============================================================================

export { FeedServiceFactory } from "./FeedServiceFactory.js";
export type { FactoryOptions } from "./FeedServiceFactory.js";

// ============================================================================
// Interfaces
// ============================================================================

export type { IFeedProvider } from "./interfaces/IFeedProvider.js";
export type { IFeedClassifier } from "./interfaces/IFeedClassifier.js";
export type {
  IFeedPublisher,
  PublishDestination,
} from "./interfaces/IFeedPublisher.js";
export type { IFeedScheduler } from "./interfaces/IFeedScheduler.js";
export type {
  IFeedRepository,
  FeedConfigRecord,
  FeedItemRecord,
} from "./interfaces/IFeedRepository.js";

// ============================================================================
// Providers
// ============================================================================

export {
  CustomProvider,
  type CustomFetchFunction,
  type CustomParseFunction,
} from "./providers/CustomProvider.js";

// ============================================================================
// Source Provider System (new pluggable feed sources — Phase 1 + 2)
// ============================================================================

export type {
  ISourceProvider,
  ResolvedConfig,
  FetchParams,
  FetchResult,
  SourceItem,
  SourceProviderMeta,
  SourceProviderCapabilities,
  TestConnectionResult,
} from "./providers/ISourceProvider.js";

export {
  HTTPAPIProvider,
  HTTPAPIConfigSchema,
  type HTTPAPIConfig,
  readPath,
} from "./providers/HTTPAPIProvider.js";
export {
  CPRelayProvider,
  CPRelayConfigSchema,
  type CPRelayConfig,
} from "./providers/CPRelayProvider.js";

export { sourceProviderRegistry } from "./providers/SourceProviderRegistry.js";
export type { SourceProviderRegistry } from "./providers/SourceProviderRegistry.js";

// Register built-in providers at import time so any code that imports
// `sourceProviderRegistry` sees them populated. This is safe because each
// provider class has no side effects in its constructor.
import { sourceProviderRegistry as _registry } from "./providers/SourceProviderRegistry.js";
import { HTTPAPIProvider as _HTTPAPIProvider } from "./providers/HTTPAPIProvider.js";
import { CPRelayProvider as _CPRelayProvider } from "./providers/CPRelayProvider.js";

_registry.register(new _HTTPAPIProvider());
_registry.register(new _CPRelayProvider());

// ============================================================================
// Classifiers
// ============================================================================

export {
  ISClassifier,
  type ISClassifierConfig,
} from "./classifiers/ISClassifier.js";
export {
  KeywordClassifier,
  type KeywordClassifierConfig,
} from "./classifiers/KeywordClassifier.js";
export { NoopClassifier } from "./classifiers/NoopClassifier.js";

// ============================================================================
// Publishers
// ============================================================================

export {
  ChannelMessagePublisher,
  type ChannelMessagePublisherConfig,
} from "./publishers/ChannelMessagePublisher.js";

// ============================================================================
// Configuration
// ============================================================================

export {
  RSSProviderConfigSchema,
  FeedSourceConfigSchema,
  NormalizedRSSItemSchema,
  ClassifiedItemSchema,
  UserContextSchema,
  FeedFetchResultSchema,
  FeedHealthStatusSchema,
  ProviderTypeSchema,
  ParserTypeSchema,
  ClassifierTypeSchema,
  PublisherTypeSchema,
  FeedServiceConfigSchema,
  type FeedServiceConfig,
} from "./config/FeedConfig.js";

export {
  type CustomProviderConfig,
  type ProviderConfigMap,
  CustomProviderDefaults,
  CustomProviderCapabilities,
  getProviderDefaults,
} from "./config/RSSProviderConfig.js";

// ============================================================================
// Types
// ============================================================================

export type {
  RSSProviderConfig,
  FeedSourceConfig,
  NormalizedRSSItem,
  ClassifiedItem,
  UserContext,
  FeedFetchResult,
  FeedHealthStatus,
  ISClassificationResult,
  ISClassificationRequest,
  ProviderCapabilities,
  FeedProviderInfo,
  ScheduledFeedJob,
  SchedulerConfig,
  PublisherConfig,
  PublishedMessageMetadata,
  FeedRepositoryQuery,
  FeedStatistics,
  KeywordCategory,
} from "./types/index.js";

// ============================================================================
// Type Check & Validation (for testing and runtime validation)
// ============================================================================

export {
  isValidProviderConfig,
  isValidSourceConfig,
  isValidNormalizedItem,
  isValidClassifiedItem,
  isValidUserContext,
} from "./type-check.js";

export type {
  // Re-export core types for convenience
  CoreFeedConfig,
  CoreRSSFeedConfig,
  CoreProactiveFeedConfig,
  CoreFeedMessageMetadata,
  CoreNormalizedRSSItem,
  CoreFeedStatus,
  CoreFeedExecutionPayload,
} from "./type-check.js";

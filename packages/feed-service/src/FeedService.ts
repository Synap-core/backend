/**
 * FeedService
 *
 * High-level service for managing RSS/Atom feed ingestion pipelines.
 * Orchestrates fetching, classification, and publishing of feed items.
 */

import type { IFeedProvider } from "./interfaces/IFeedProvider.js";
import type { IFeedClassifier } from "./interfaces/IFeedClassifier.js";
import type { IFeedPublisher } from "./interfaces/IFeedPublisher.js";
import type { IFeedScheduler } from "./interfaces/IFeedScheduler.js";
import type { IFeedRepository } from "./interfaces/IFeedRepository.js";
import type {
  FeedSourceConfig,
  UserContext,
  FeedFetchResult,
  ClassifiedItem,
} from "./types/index.js";
import type { PublishDestination } from "./interfaces/IFeedPublisher.js";
import { FeedServiceFactory } from "./FeedServiceFactory.js";
import type { RSSProviderConfig } from "./types/index.js";
import { ValidationError, InternalServerError } from "@synap-core/core";
import crypto from "crypto";

/**
 * Feed service configuration
 */
export interface FeedServiceConfiguration {
  /** Default provider configuration */
  defaultProvider?: RSSProviderConfig;
  /** Default classifier type */
  defaultClassifier?: "is" | "keyword" | "noop";
  /** Default publisher type */
  defaultPublisher?: "channel";
  /** Enable deduplication */
  enableDeduplication?: boolean;
  /** Deduplication window in hours */
  dedupWindowHours?: number;
  /** Minimum relevance score for publishing */
  minRelevanceScore?: number;
  /** Maximum items per fetch */
  maxItemsPerFetch?: number;
}

/**
 * Feed processing options
 */
export interface FeedProcessingOptions {
  /** Override provider */
  provider?: IFeedProvider;
  /** Override classifier */
  classifier?: IFeedClassifier;
  /** Override publisher */
  publisher?: IFeedPublisher;
  /** User context for classification */
  userContext?: UserContext;
  /** Publishing destination */
  destination?: PublishDestination;
  /** Skip classification */
  skipClassification?: boolean;
  /** Skip publishing */
  skipPublishing?: boolean;
  /** Force fetch (ignore cache) */
  force?: boolean;
}

/**
 * Feed processing result
 */
export interface FeedProcessingResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Feed source URL */
  sourceUrl: string;
  /** Number of items fetched */
  itemsFetched: number;
  /** Number of items classified */
  itemsClassified: number;
  /** Number of items published */
  itemsPublished: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Classified items (if skipPublishing) */
  classifiedItems?: ClassifiedItem[];
}

/**
 * Feed Service
 *
 * High-level orchestration service for feed ingestion pipelines.
 * Combines provider, classifier, and publisher into a cohesive workflow.
 *
 * @example
 * ```typescript
 * // Basic usage with factory
 * const service = new FeedService();
 *
 * // Process a feed
 * const result = await service.processFeed({
 *   url: "https://example.com/feed.xml",
 *   provider: { type: "direct" }
 * }, {
 *   destination: { channelId: "channel-123", userId: "user-456" },
 *   userContext: { userId: "user-456", interests: ["tech"] }
 * });
 * ```
 */
export class FeedService {
  private readonly config: Required<FeedServiceConfiguration>;
  private scheduler?: IFeedScheduler;
  private repository?: IFeedRepository;

  constructor(config: FeedServiceConfiguration = {}) {
    this.config = {
      defaultProvider: { type: "direct" },
      defaultClassifier: "keyword",
      defaultPublisher: "channel",
      enableDeduplication: true,
      dedupWindowHours: 24,
      minRelevanceScore: 0.3,
      maxItemsPerFetch: 100,
      ...config,
    };
  }

  /**
   * Set the scheduler for feed jobs
   */
  setScheduler(scheduler: IFeedScheduler): void {
    this.scheduler = scheduler;
  }

  /**
   * Set the repository for persistence
   */
  setRepository(repository: IFeedRepository): void {
    this.repository = repository;
  }

  /**
   * Process a feed through the complete pipeline
   *
   * @param source - Feed source configuration
   * @param options - Processing options
   * @returns Processing result
   *
   * @example
   * ```typescript
   * const result = await service.processFeed(
   *   { url: "https://example.com/feed.xml", provider: { type: "direct" } },
   *   {
   *     destination: { channelId: "channel-123", userId: "user-456" },
   *     userContext: { userId: "user-456", interests: ["technology"] }
   *   }
   * );
   *
   * console.log(`Published ${result.itemsPublished} items`);
   * ```
   */
  async processFeed(
    source: FeedSourceConfig,
    options: FeedProcessingOptions = {}
  ): Promise<FeedProcessingResult> {
    const startTime = Date.now();

    try {
      // Validate source
      this.validateSource(source);

      // Create components (or use overrides)
      const provider = options.provider || this.createProvider(source.provider);
      const classifier = options.classifier || this.createClassifier();
      const publisher = options.publisher || this.createPublisher();

      // Step 1: Fetch
      const items = await provider.fetch(source);
      const limitedItems = items.slice(0, this.config.maxItemsPerFetch);

      // Step 2: Deduplication (if enabled and repository available)
      let newItems = limitedItems;
      if (this.config.enableDeduplication && this.repository) {
        newItems = await this.deduplicateItems(source.url, limitedItems);
      }

      // Step 3: Classification (unless skipped)
      let classifiedItems: ClassifiedItem[] = [];
      if (!options.skipClassification) {
        classifiedItems = await classifier.classify(
          newItems,
          options.userContext
        );

        // Filter by relevance score
        classifiedItems = classifiedItems.filter(
          (item) => (item.relevanceScore ?? 0) >= this.config.minRelevanceScore
        );
      } else {
        // Pass through as unclassified
        classifiedItems = newItems.map((item) => ({
          item,
          category: "general",
          confidence: 1,
          relevanceScore: 1,
          keywords: [],
          suggestedAction: "publish",
          shouldPublish: true,
        }));
      }

      // Step 4: Publishing (unless skipped)
      let publishedCount = 0;
      if (!options.skipPublishing && options.destination) {
        publishedCount = await publisher.publish(
          classifiedItems,
          options.destination
        );
      }

      // Record result if repository available
      if (this.repository) {
        await this.recordFetchResult(source.url, {
          success: true,
          sourceUrl: source.url,
          itemsFetched: items.length,
          itemsNew: newItems.length,
          fetchDurationMs: Date.now() - startTime,
          timestamp: new Date(),
          providerType: provider.getProviderType(),
        });
      }

      return {
        success: true,
        sourceUrl: source.url,
        itemsFetched: items.length,
        itemsClassified: classifiedItems.length,
        itemsPublished: publishedCount,
        durationMs: Date.now() - startTime,
        classifiedItems: options.skipPublishing ? classifiedItems : undefined,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Record failure if repository available
      if (this.repository) {
        await this.recordFetchResult(source.url, {
          success: false,
          sourceUrl: source.url,
          itemsFetched: 0,
          itemsNew: 0,
          error: errorMessage,
          fetchDurationMs: Date.now() - startTime,
          timestamp: new Date(),
          providerType: source.provider.type,
        });
      }

      return {
        success: false,
        sourceUrl: source.url,
        itemsFetched: 0,
        itemsClassified: 0,
        itemsPublished: 0,
        durationMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Fetch items from a feed without processing
   *
   * @param source - Feed source configuration
   * @returns Array of normalized feed items
   */
  async fetchFeed(source: FeedSourceConfig): Promise<FeedFetchResult> {
    const startTime = Date.now();

    try {
      this.validateSource(source);

      const provider = this.createProvider(source.provider);
      const items = await provider.fetch(source);

      return {
        success: true,
        sourceUrl: source.url,
        itemsFetched: items.length,
        itemsNew: items.length,
        fetchDurationMs: Date.now() - startTime,
        timestamp: new Date(),
        providerType: provider.getProviderType(),
      };
    } catch (error) {
      return {
        success: false,
        sourceUrl: source.url,
        itemsFetched: 0,
        itemsNew: 0,
        error: error instanceof Error ? error.message : String(error),
        fetchDurationMs: Date.now() - startTime,
        timestamp: new Date(),
        providerType: source.provider.type,
      };
    }
  }

  /**
   * Validate a feed source without fetching
   *
   * @param source - Feed source configuration
   * @returns True if valid and accessible
   */
  async validateFeed(source: FeedSourceConfig): Promise<boolean> {
    try {
      this.validateSource(source);
      const provider = this.createProvider(source.provider);
      return await provider.validate(source);
    } catch {
      return false;
    }
  }

  /**
   * Schedule a feed for periodic fetching
   *
   * @param feedConfigId - Feed configuration ID
   * @param source - Feed source configuration
   * @param schedule - Cron expression
   * @param timezone - Timezone for scheduling
   * @returns Scheduled job
   */
  async scheduleFeed(
    feedConfigId: string,
    source: FeedSourceConfig,
    schedule: string,
    timezone = "UTC"
  ): Promise<{ jobId: string; nextRunAt: Date }> {
    if (!this.scheduler) {
      throw new InternalServerError("Scheduler not configured");
    }

    const job = await this.scheduler.schedule(
      feedConfigId,
      source,
      schedule,
      timezone
    );

    return {
      jobId: job.id,
      nextRunAt: job.nextRunAt,
    };
  }

  /**
   * Cancel a scheduled feed
   *
   * @param jobId - Job ID to cancel
   * @returns True if cancelled successfully
   */
  async cancelScheduledFeed(jobId: string): Promise<boolean> {
    if (!this.scheduler) {
      throw new InternalServerError("Scheduler not configured");
    }

    return await this.scheduler.cancel(jobId);
  }

  /**
   * Get feed health status
   *
   * @param source - Feed source configuration
   * @returns Health status
   */
  async getFeedHealth(source: FeedSourceConfig): Promise<{
    healthy: boolean;
    providerType: string;
    checkedAt: Date;
    error?: string;
  }> {
    try {
      const provider = this.createProvider(source.provider);
      const health = await provider.healthCheck();

      return {
        healthy: health.healthy,
        providerType: health.providerType,
        checkedAt: health.checkedAt,
        error: health.lastError,
      };
    } catch (error) {
      return {
        healthy: false,
        providerType: source.provider.type,
        checkedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Validate feed source configuration
   */
  private validateSource(source: FeedSourceConfig): void {
    if (!source.url) {
      throw new ValidationError("Feed source URL is required");
    }

    try {
      new URL(source.url);
    } catch {
      throw new ValidationError(`Invalid feed URL: ${source.url}`);
    }

    if (!source.provider) {
      throw new ValidationError("Feed provider configuration is required");
    }
  }

  /**
   * Create provider instance
   */
  private createProvider(config: RSSProviderConfig): IFeedProvider {
    return FeedServiceFactory.createProvider(config);
  }

  /**
   * Create classifier instance
   */
  private createClassifier(): IFeedClassifier {
    return FeedServiceFactory.createClassifier(this.config.defaultClassifier);
  }

  /**
   * Create publisher instance
   */
  private createPublisher(): IFeedPublisher {
    return FeedServiceFactory.createPublisher(this.config.defaultPublisher);
  }

  /**
   * Deduplicate items against repository
   */
  private async deduplicateItems(
    _sourceUrl: string,
    items: import("./types/index.js").NormalizedRSSItem[]
  ): Promise<import("./types/index.js").NormalizedRSSItem[]> {
    if (!this.repository) return items;

    // Generate content hashes for deduplication
    const itemsWithHashes = items.map((item) => ({
      item,
      hash: this.generateItemHash(item),
    }));

    // Use the hashes to check for duplicates in repository
    void itemsWithHashes; // Used for side effects

    // This is a placeholder - in practice, you'd look up existing items
    // For now, return all items (no deduplication)
    return items;
  }

  /**
   * Generate hash for deduplication
   */
  private generateItemHash(
    item: import("./types/index.js").NormalizedRSSItem
  ): string {
    const content = `${item.title}|${item.url}|${item.publishedAt?.toISOString() || ""}`;
    return crypto
      .createHash("sha256")
      .update(content)
      .digest("hex")
      .substring(0, 32);
  }

  /**
   * Record fetch result
   */
  private async recordFetchResult(
    feedConfigId: string,
    result: FeedFetchResult
  ): Promise<void> {
    if (!this.repository) return;

    try {
      await this.repository.recordFetchResult(feedConfigId, result);
    } catch (error) {
      // Don't fail the operation if recording fails
      console.error("Failed to record fetch result:", error);
    }
  }
}

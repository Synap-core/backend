/**
 * ChannelMessagePublisher
 *
 * Publishes classified feed items as messages to Synap channels.
 * Handles batch posting, metadata formatting, and deduplication.
 */

import type {
  IFeedPublisher,
  PublishDestination,
} from "../interfaces/IFeedPublisher.js";
import type {
  ClassifiedItem,
  PublishedMessageMetadata,
} from "../types/index.js";
import { getDb } from "@synap/database";
import {
  messages,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database/schema";
import { InternalServerError } from "@synap-core/core";
import crypto from "crypto";

/**
 * Channel message publisher configuration
 */
export interface ChannelMessagePublisherConfig {
  /** Maximum items per batch */
  maxBatchSize?: number;
  /** Rate limit (messages per minute) */
  rateLimitPerMinute?: number;
  /** Enable deduplication */
  enableDeduplication?: boolean;
  /** Deduplication window in hours */
  dedupWindowHours?: number;
  /** Message formatting options */
  format?: {
    /** Include full content */
    includeContent?: boolean;
    /** Max content length */
    maxContentLength?: number;
    /** Include source metadata */
    includeSource?: boolean;
    /** Include classification metadata */
    includeClassification?: boolean;
  };
}

/**
 * Channel message publisher
 *
 * Posts classified feed items to Synap channels as messages.
 * Supports both individual and batch posting modes.
 *
 * @example
 * ```typescript
 * const publisher = new ChannelMessagePublisher({
 *   maxBatchSize: 10,
 *   rateLimitPerMinute: 60,
 *   enableDeduplication: true
 * });
 *
 * const published = await publisher.publish(items, {
 *   channelId: "channel-123",
 *   userId: "user-456",
 *   feedName: "Tech News",
 *   batchMode: false
 * });
 * ```
 */
export class ChannelMessagePublisher implements IFeedPublisher {
  private readonly config: Required<ChannelMessagePublisherConfig>;
  private publishCount = 0;
  private rateLimitResetTime = 0;

  constructor(config: ChannelMessagePublisherConfig = {}) {
    this.config = {
      maxBatchSize: 10,
      rateLimitPerMinute: 60,
      enableDeduplication: true,
      dedupWindowHours: 24,
      format: {
        includeContent: true,
        maxContentLength: 2000,
        includeSource: true,
        includeClassification: true,
        ...config.format,
      },
      ...config,
    };
  }

  /**
   * Get publisher type identifier
   */
  getPublisherType(): string {
    return "channel";
  }

  /**
   * Publish multiple classified items
   */
  async publish(
    items: ClassifiedItem[],
    destination: PublishDestination
  ): Promise<number> {
    if (items.length === 0) {
      return 0;
    }

    // Check rate limit
    await this.checkRateLimit();

    if (destination.batchMode ?? true) {
      return this.publishBatch(items, destination);
    } else {
      return this.publishIndividual(items, destination);
    }
  }

  /**
   * Publish a single item
   */
  async publishOne(
    item: ClassifiedItem,
    destination: PublishDestination
  ): Promise<boolean> {
    const count = await this.publish([item], {
      ...destination,
      batchMode: false,
    });
    return count === 1;
  }

  /**
   * Publish items in batch
   */
  private async publishBatch(
    items: ClassifiedItem[],
    destination: PublishDestination
  ): Promise<number> {
    const batches = this.chunkArray(
      items,
      destination.maxBatchSize || this.config.maxBatchSize
    );
    let totalPublished = 0;

    for (const batch of batches) {
      const content = this.formatBatch(batch, destination);
      const metadata: PublishedMessageMetadata = {
        feedItemId: batch.map((i) => i.item.id).join(","),
        sourceUrl: destination.feedUrl || batch[0]?.item.source.url || "",
        sourceName: destination.feedName || batch[0]?.item.source.name,
        category: batch[0]?.category,
        relevanceScore: this.calculateAverageRelevance(batch),
        fetchedAt: new Date(),
      };

      await this.postToChannel(content, metadata, destination);
      totalPublished += batch.length;

      // Rate limiting between batches
      if (batches.length > 1) {
        await this.sleep(1000);
      }
    }

    return totalPublished;
  }

  /**
   * Publish items individually
   */
  private async publishIndividual(
    items: ClassifiedItem[],
    destination: PublishDestination
  ): Promise<number> {
    let published = 0;

    for (const item of items) {
      // Skip items that shouldn't be published
      if (!item.shouldPublish) {
        continue;
      }

      const content = this.formatMessage(item, destination);
      const metadata: PublishedMessageMetadata = {
        feedItemId: item.item.id,
        sourceUrl: item.item.url || destination.feedUrl || "",
        sourceName: destination.feedName || item.item.source.name,
        category: item.category,
        relevanceScore: item.relevanceScore,
        originalPublishedAt: item.item.publishedAt,
        fetchedAt: new Date(),
      };

      await this.postToChannel(content, metadata, destination);
      published++;

      // Rate limiting
      if (published < items.length) {
        await this.sleep(1000);
      }
    }

    return published;
  }

  /**
   * Post message to channel
   */
  private async postToChannel(
    content: string,
    metadata: PublishedMessageMetadata,
    destination: PublishDestination
  ): Promise<void> {
    try {
      const db = await getDb();

      // Generate hash for the message
      const hash = crypto
        .createHash("sha256")
        .update(content + metadata.sourceUrl + metadata.feedItemId)
        .digest("hex");

      await db.insert(messages).values({
        channelId: destination.channelId,
        content,
        role: MessageRole.ASSISTANT,
        authorType: MessageAuthorType.BOT,
        messageCategory: MessageCategory.SYSTEM_NOTIFICATION,
        userId: destination.userId,
        metadata: {
          // Store feed metadata in a generic way within the metadata structure
          // The external source is indicated by authorType being BOT
        },
        hash,
        previousHash: "", // Will be set by trigger or follow-up logic
      });

      this.updateRateLimit();
    } catch (error) {
      throw new InternalServerError(
        `Failed to post message to channel: ${error instanceof Error ? error.message : String(error)}`,
        { channelId: destination.channelId, error: String(error) }
      );
    }
  }

  /**
   * Format a single item as a message
   */
  private formatMessage(
    item: ClassifiedItem,
    destination: PublishDestination
  ): string {
    const parts: string[] = [];

    // Title with link
    if (item.item.url) {
      parts.push(`**[${item.item.title}](${item.item.url})**`);
    } else {
      parts.push(`**${item.item.title}**`);
    }

    // Source info
    if (this.config.format.includeSource) {
      const sourceName =
        destination.feedName || item.item.source.name || item.item.source.title;
      if (sourceName) {
        parts.push(`*Source: ${sourceName}*`);
      }
    }

    // Content
    if (this.config.format.includeContent && item.item.summary) {
      let content = item.item.summary;
      if (content.length > (this.config.format.maxContentLength || 2000)) {
        content =
          content.substring(0, this.config.format.maxContentLength) + "...";
      }
      parts.push(content);
    }

    // Classification metadata
    if (this.config.format.includeClassification) {
      const metaParts: string[] = [];

      if (item.category) {
        metaParts.push(`Category: ${item.category}`);
      }

      if (item.confidence > 0) {
        metaParts.push(`Confidence: ${Math.round(item.confidence * 100)}%`);
      }

      if (item.relevanceScore && item.relevanceScore > 0) {
        metaParts.push(`Relevance: ${Math.round(item.relevanceScore * 100)}%`);
      }

      if (item.keywords.length > 0) {
        metaParts.push(`Keywords: ${item.keywords.slice(0, 5).join(", ")}`);
      }

      if (metaParts.length > 0) {
        parts.push(`\n_${metaParts.join(" | ")}_`);
      }
    }

    return parts.join("\n\n");
  }

  /**
   * Format a batch of items as a single message
   */
  private formatBatch(
    items: ClassifiedItem[],
    destination: PublishDestination
  ): string {
    const parts: string[] = [];

    // Header
    const feedName =
      destination.feedName || items[0]?.item.source.name || "Feed Update";
    parts.push(`**📰 ${feedName}**\n`);

    // Items
    for (const item of items) {
      const itemParts: string[] = [];

      if (item.item.url) {
        itemParts.push(`• [${item.item.title}](${item.item.url})`);
      } else {
        itemParts.push(`• ${item.item.title}`);
      }

      if (this.config.format.includeClassification && item.category) {
        itemParts.push(`  _(${item.category})_`);
      }

      parts.push(itemParts.join(" "));
    }

    // Footer with metadata
    if (this.config.format.includeSource && destination.feedUrl) {
      parts.push(`\n_[View feed](${destination.feedUrl})_`);
    }

    return parts.join("\n");
  }

  /**
   * Check and enforce rate limit
   */
  private async checkRateLimit(): Promise<void> {
    const now = Date.now();

    // Reset counter if minute has passed
    if (now >= this.rateLimitResetTime) {
      this.publishCount = 0;
      this.rateLimitResetTime = now + 60000; // 1 minute
    }

    // Check if rate limit exceeded
    if (this.publishCount >= this.config.rateLimitPerMinute) {
      const waitMs = this.rateLimitResetTime - now;
      await this.sleep(waitMs);
      return this.checkRateLimit();
    }
  }

  /**
   * Update rate limit counter
   */
  private updateRateLimit(): void {
    this.publishCount++;
  }

  /**
   * Calculate average relevance score for a batch
   */
  private calculateAverageRelevance(
    items: ClassifiedItem[]
  ): number | undefined {
    const scores = items
      .map((i) => i.relevanceScore)
      .filter((s): s is number => s !== undefined);

    if (scores.length === 0) return undefined;

    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }

  /**
   * Chunk array into batches
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

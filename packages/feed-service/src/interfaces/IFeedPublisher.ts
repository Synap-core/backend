/**
 * IFeedPublisher Interface
 *
 * Defines the contract for publishing classified feed items to destinations.
 * Implementations handle posting feed content to channels, webhooks, or queues.
 */

import type { ClassifiedItem } from "../types/index.js";

/**
 * Feed publisher interface
 *
 * Publishers are responsible for delivering classified feed items to
 * their final destination. The primary implementation posts to Synap
 * channels as messages.
 */
export interface IFeedPublisher {
  /**
   * Publish classified feed items
   *
   * Posts the classified items to the configured destination. Items may be
   * published individually or in batches depending on the configuration.
   *
   * @param items - Array of classified items to publish
   * @param destination - Destination configuration (e.g., channel ID)
   * @returns Promise resolving to number of items successfully published
   * @throws FeedPublishError if publishing fails
   *
   * @example
   * ```typescript
   * const publisher = new ChannelMessagePublisher();
   * const published = await publisher.publish(
   *   classifiedItems,
   *   { channelId: "channel-123", userId: "user-456" }
   * );
   * console.log(`Published ${published} items`);
   * ```
   */
  publish(
    items: ClassifiedItem[],
    destination: PublishDestination
  ): Promise<number>;

  /**
   * Publish a single classified item
   *
   * Convenience method for publishing a single item.
   *
   * @param item - Classified item to publish
   * @param destination - Destination configuration
   * @returns Promise resolving to true if published successfully
   */
  publishOne(
    item: ClassifiedItem,
    destination: PublishDestination
  ): Promise<boolean>;

  /**
   * Get the publisher type identifier
   *
   * @returns Publisher type string (e.g., "channel", "webhook")
   *
   * @example
   * ```typescript
   * const type = publisher.getPublisherType(); // "channel"
   * ```
   */
  getPublisherType(): string;
}

/**
 * Destination configuration for publishing
 */
export interface PublishDestination {
  /** Target channel ID */
  channelId: string;
  /** User ID for message attribution */
  userId: string;
  /** Optional workspace ID */
  workspaceId?: string;
  /** Feed source name for metadata */
  feedName?: string;
  /** Feed source URL for metadata */
  feedUrl?: string;
  /** Publish in batch mode */
  batchMode?: boolean;
  /** Maximum batch size */
  maxBatchSize?: number;
}

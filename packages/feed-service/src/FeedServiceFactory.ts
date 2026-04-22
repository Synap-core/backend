/**
 * FeedServiceFactory
 *
 * Factory for creating feed service components.
 * Provides a centralized way to instantiate providers, classifiers, and publishers.
 */

import type { IFeedProvider } from "./interfaces/IFeedProvider.js";
import type { IFeedClassifier } from "./interfaces/IFeedClassifier.js";
import type { IFeedPublisher } from "./interfaces/IFeedPublisher.js";
import type { RSSProviderConfig } from "./types/index.js";

import { CustomProvider } from "./providers/CustomProvider.js";
import { ISClassifier } from "./classifiers/ISClassifier.js";
import { KeywordClassifier } from "./classifiers/KeywordClassifier.js";
import { NoopClassifier } from "./classifiers/NoopClassifier.js";
import { ChannelMessagePublisher } from "./publishers/ChannelMessagePublisher.js";
import type { ISClassifierConfig } from "./classifiers/ISClassifier.js";
import type { KeywordClassifierConfig } from "./classifiers/KeywordClassifier.js";
import type { ChannelMessagePublisherConfig } from "./publishers/ChannelMessagePublisher.js";
import type { CustomProviderConfig } from "./config/RSSProviderConfig.js";

/**
 * Factory options for creating components
 */
export interface FactoryOptions {
  /** User agent string for HTTP requests */
  userAgent?: string;
  /** IS classifier configuration */
  isConfig?: ISClassifierConfig;
  /** Keyword classifier configuration */
  keywordConfig?: KeywordClassifierConfig;
  /** Publisher configuration */
  publisherConfig?: ChannelMessagePublisherConfig;
}

/**
 * Feed service factory
 *
 * Central factory for creating feed service components with proper configuration.
 * Handles type-safe instantiation of providers, classifiers, and publishers.
 *
 * // Create a classifier
 * const classifier = FeedServiceFactory.createClassifier("keyword");
 *
 * // Create a publisher
 * const publisher = FeedServiceFactory.createPublisher("channel");
 * ```
 */
export class FeedServiceFactory {
  private static options: FactoryOptions = {};

  /**
   * Configure the factory with default options
   */
  static configure(options: FactoryOptions): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Create a feed provider based on configuration
   *
   * @param config - Provider configuration
   * @returns Configured provider instance
   * @throws Error if provider type is not supported
   *
   * @example
   * ```typescript
   * const provider = FeedServiceFactory.createProvider({
   *   type: "direct",
   *   timeoutMs: 30000,
   *   retryAttempts: 3
   * });
   * ```
   */
  static createProvider(config: RSSProviderConfig): IFeedProvider {
    switch (config.type) {
      case "custom":
        return new CustomProvider(config as CustomProviderConfig);

      default:
        throw new Error(
          `Unsupported provider type: ${(config as RSSProviderConfig).type}`
        );
    }
  }

  /**
   * Create a feed classifier
   *
   * @param type - Classifier type: 'is', 'keyword', or 'noop'
   * @returns Configured classifier instance
   * @throws Error if classifier type is not supported
   *
   * @example
   * ```typescript
   * // AI-powered classification
   * const isClassifier = FeedServiceFactory.createClassifier("is");
   *
   * // Fast local classification
   * const keywordClassifier = FeedServiceFactory.createClassifier("keyword");
   *
   * // No-op for testing
   * const noopClassifier = FeedServiceFactory.createClassifier("noop");
   * ```
   */
  static createClassifier(type: "is" | "keyword" | "noop"): IFeedClassifier {
    switch (type) {
      case "is":
        if (!this.options.isConfig) {
          throw new Error(
            "IS classifier requires configuration. Call FeedServiceFactory.configure({ isConfig: {...} }) first."
          );
        }
        return new ISClassifier(this.options.isConfig);

      case "keyword":
        return new KeywordClassifier(this.options.keywordConfig);

      case "noop":
        return new NoopClassifier();

      default:
        throw new Error(`Unsupported classifier type: ${type}`);
    }
  }

  /**
   * Create a feed publisher
   *
   * @param type - Publisher type: 'channel'
   * @returns Configured publisher instance
   * @throws Error if publisher type is not supported
   *
   * @example
   * ```typescript
   * const publisher = FeedServiceFactory.createPublisher("channel");
   * ```
   */
  static createPublisher(type: "channel"): IFeedPublisher {
    switch (type) {
      case "channel":
        return new ChannelMessagePublisher(this.options.publisherConfig);

      default:
        throw new Error(`Unsupported publisher type: ${type}`);
    }
  }

  /**
   * Create a complete feed processing pipeline
   *
   * @param config - Pipeline configuration
   * @returns Object containing provider, classifier, and publisher
   *
   * @example
   * ```typescript
   * const pipeline = FeedServiceFactory.createPipeline({
   *   provider: { type: "direct" },
   *   classifier: "keyword",
   *   publisher: "channel"
   * });
   *
   * // Use the pipeline
   * const items = await pipeline.provider.fetch(source);
   * const classified = await pipeline.classifier.classify(items, context);
   * await pipeline.publisher.publish(classified, destination);
   * ```
   */
  static createPipeline(config: {
    provider: RSSProviderConfig;
    classifier: "is" | "keyword" | "noop";
    publisher: "channel";
  }): {
    provider: IFeedProvider;
    classifier: IFeedClassifier;
    publisher: IFeedPublisher;
  } {
    return {
      provider: this.createProvider(config.provider),
      classifier: this.createClassifier(config.classifier),
      publisher: this.createPublisher(config.publisher),
    };
  }

  /**
   * Get available provider types
   */
  static getAvailableProviders(): string[] {
    return ["custom"];
  }

  /**
   * Get available classifier types
   */
  static getAvailableClassifiers(): string[] {
    return ["is", "keyword", "noop"];
  }

  /**
   * Get available publisher types
   */
  static getAvailablePublishers(): string[] {
    return ["channel"];
  }
}

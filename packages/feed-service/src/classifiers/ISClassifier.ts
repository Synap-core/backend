/**
 * ISClassifier
 *
 * Intelligence Service-based classifier that uses the IS /v1/tools/classify_feed_items
 * endpoint for AI-powered feed item classification.
 */

import type { IFeedClassifier } from "../interfaces/IFeedClassifier.js";
import type {
  NormalizedRSSItem,
  ClassifiedItem,
  UserContext,
  ISClassificationRequest,
  ISClassificationResult,
} from "../types/index.js";
import { ServiceUnavailableError } from "@synap-core/core";

/**
 * IS classifier configuration
 */
export interface ISClassifierConfig {
  /** IS service base URL */
  isServiceUrl: string;
  /** IS service API key */
  isServiceApiKey: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Minimum confidence threshold */
  minConfidence?: number;
  /** Enable keyword fallback on failure */
  enableFallback?: boolean;
  /** Number of retry attempts */
  retryAttempts?: number;
}

/**
 * Intelligence Service feed classifier
 *
 * Uses the IS API to classify feed items with AI-powered topic extraction,
 * relevance scoring, and suggested actions. Falls back to keyword classification
 * on IS failures if enabled.
 *
 * @example
 * ```typescript
 * const classifier = new ISClassifier({
 *   isServiceUrl: "https://is.synap.io",
 *   isServiceApiKey: "api-key",
 *   minConfidence: 0.6,
 *   enableFallback: true
 * });
 *
 * const classified = await classifier.classify(items, {
 *   userId: "user-123",
 *   interests: ["technology", "ai"]
 * });
 * ```
 */
export class ISClassifier implements IFeedClassifier {
  private readonly config: ISClassifierConfig;

  constructor(config: ISClassifierConfig) {
    this.config = {
      timeoutMs: 30000,
      minConfidence: 0.5,
      enableFallback: true,
      retryAttempts: 2,
      ...config,
    };

    if (!this.config.isServiceUrl) {
      throw new Error("ISClassifier requires isServiceUrl");
    }

    if (!this.config.isServiceApiKey) {
      throw new Error("ISClassifier requires isServiceApiKey");
    }
  }

  /**
   * Get classifier type identifier
   */
  getClassifierType(): string {
    return "is";
  }

  /**
   * Classify feed items using IS API
   */
  async classify(
    items: NormalizedRSSItem[],
    context?: UserContext
  ): Promise<ClassifiedItem[]> {
    if (items.length === 0) {
      return [];
    }

    try {
      const results = await this.classifyWithIS(items, context);
      return this.mapResultsToClassifiedItems(items, results);
    } catch (error) {
      // If fallback is enabled, use keyword classification
      if (this.config.enableFallback) {
        console.warn(
          `IS classification failed, falling back to keywords: ${error instanceof Error ? error.message : String(error)}`
        );
        return this.fallbackToKeywords(items, context);
      }

      throw new ServiceUnavailableError(
        `IS classification failed and fallback is disabled: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Call IS classification API
   */
  private async classifyWithIS(
    items: NormalizedRSSItem[],
    context?: UserContext
  ): Promise<ISClassificationResult[]> {
    const request: ISClassificationRequest = {
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        url: item.url,
        publishedAt: item.publishedAt,
      })),
      context: context
        ? {
            userId: context.userId,
            workspaceId: context.workspaceId,
            interests: context.interests,
            priorityKeywords: context.priorityKeywords,
            excludeKeywords: context.excludeKeywords,
            preferredCategories: context.preferredCategories,
          }
        : undefined,
      options: {
        extractKeywords: true,
        calculateRelevance: true,
        maxCategories: 5,
      },
    };

    const maxAttempts = this.config.retryAttempts || 1;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(
          `${this.config.isServiceUrl}/v1/tools/classify_feed_items`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.config.isServiceApiKey}`,
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(this.config.timeoutMs || 30000),
          }
        );

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          throw new ServiceUnavailableError(
            `IS classification API returned ${response.status}: ${errorText}`,
            { status: response.status }
          );
        }

        const data = (await response.json()) as {
          results?: ISClassificationResult[];
        };
        return data.results || [];
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxAttempts) {
          const delay = Math.min(1000 * attempt, 5000);
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Map IS results to classified items
   */
  private mapResultsToClassifiedItems(
    items: NormalizedRSSItem[],
    results: ISClassificationResult[]
  ): ClassifiedItem[] {
    return items.map((item): ClassifiedItem => {
      // Try to find matching result by category or use first result
      const result =
        results.find((r) =>
          item.categories.some(
            (c) => c.toLowerCase() === r.category.toLowerCase()
          )
        ) || results[0];

      const confidence = result?.confidence ?? 0.5;
      const relevanceScore = this.calculateRelevanceScore(item, result);

      return {
        item,
        category: result?.category || "general",
        confidence,
        relevanceScore,
        keywords: result?.keywords || [],
        suggestedAction: result?.suggestedAction,
        shouldPublish:
          confidence >= (this.config.minConfidence || 0.5) &&
          relevanceScore > 0.3,
      };
    });
  }

  /**
   * Calculate relevance score based on IS result and context
   */
  private calculateRelevanceScore(
    item: NormalizedRSSItem,
    result?: ISClassificationResult
  ): number {
    if (!result) return 0.5;

    // Base relevance from IS
    let score = result.relevanceScore ?? result.confidence * 0.8;

    // Boost if keywords match item categories
    if (result.keywords && item.categories.length > 0) {
      const matchingKeywords = result.keywords.filter((k) =>
        item.categories.some((c) => c.toLowerCase().includes(k.toLowerCase()))
      );
      score +=
        (matchingKeywords.length / Math.max(result.keywords.length, 1)) * 0.2;
    }

    // Normalize to 0-1
    return Math.min(Math.max(score, 0), 1);
  }

  /**
   * Fallback to keyword-based classification
   */
  private fallbackToKeywords(
    items: NormalizedRSSItem[],
    context?: UserContext
  ): Promise<ClassifiedItem[]> {
    // Dynamically import to avoid circular dependency
    const { KeywordClassifier } = require("./KeywordClassifier.js");
    const fallback = new KeywordClassifier();
    return fallback.classify(items, context);
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * IFeedClassifier Interface
 *
 * Defines the contract for feed item classification.
 * Implementations analyze feed items and assign categories, relevance scores,
 * and suggested actions based on content and user context.
 */

import type {
  NormalizedRSSItem,
  ClassifiedItem,
  UserContext,
} from "../types/index.js";

/**
 * Feed classifier interface
 *
 * Classifiers analyze feed items and assign metadata for filtering,
 * prioritization, and routing. Implementations may use local algorithms
 * (keyword matching) or external AI services (IS classification).
 */
export interface IFeedClassifier {
  /**
   * Classify feed items
   *
   * Analyzes an array of feed items and returns classified versions
   * with categories, relevance scores, and suggested actions.
   *
   * @param items - Array of normalized feed items to classify
   * @param context - Optional user context for personalization
   * @returns Promise resolving to array of classified items
   * @throws FeedClassificationError if classification fails
   *
   * @example
   * ```typescript
   * const classifier = new KeywordClassifier();
   * const classified = await classifier.classify(
   *   [{ id: "1", title: "Tech News", content: "...", source: { url: "..." } }],
   *   { userId: "user-123", interests: ["technology", "ai"] }
   * );
   * // classified[0].category = "technology"
   * // classified[0].relevanceScore = 0.85
   * ```
   */
  classify(
    items: NormalizedRSSItem[],
    context?: UserContext
  ): Promise<ClassifiedItem[]>;

  /**
   * Get the classifier type identifier
   *
   * @returns Classifier type string (e.g., "is", "keyword", "noop")
   *
   * @example
   * ```typescript
   * const type = classifier.getClassifierType(); // "keyword"
   * ```
   */
  getClassifierType(): string;
}

/**
 * NoopClassifier
 *
 * Pass-through classifier that performs no classification.
 * Useful for testing or when classification is not needed.
 */

import type { IFeedClassifier } from "../interfaces/IFeedClassifier.js";
import type {
  NormalizedRSSItem,
  ClassifiedItem,
  UserContext,
} from "../types/index.js";

/**
 * No-operation classifier
 *
 * Returns items with default/empty classification. All items pass through
 * with shouldPublish = true. Useful for:
 * - Testing feed fetching without classification overhead
 * - Feeds that don't need categorization
 * - Debugging and development
 *
 * @example
 * ```typescript
 * const classifier = new NoopClassifier({ markAllAs: "technology" });
 * const classified = await classifier.classify(items);
 * // All items have category "technology", confidence 1.0, shouldPublish true
 * ```
 */
export class NoopClassifier implements IFeedClassifier {
  private readonly defaultCategory: string;
  private readonly defaultConfidence: number;
  private readonly defaultRelevance: number;
  private readonly shouldPublish: boolean;

  constructor(
    options: {
      /** Default category for all items */
      defaultCategory?: string;
      /** Default confidence score */
      defaultConfidence?: number;
      /** Default relevance score */
      defaultRelevance?: number;
      /** Whether all items should be published */
      shouldPublish?: boolean;
    } = {}
  ) {
    this.defaultCategory = options.defaultCategory || "general";
    this.defaultConfidence = options.defaultConfidence ?? 1.0;
    this.defaultRelevance = options.defaultRelevance ?? 1.0;
    this.shouldPublish = options.shouldPublish ?? true;
  }

  /**
   * Get classifier type identifier
   */
  getClassifierType(): string {
    return "noop";
  }

  /**
   * Pass through items without classification
   */
  async classify(
    items: NormalizedRSSItem[],
    _context?: UserContext
  ): Promise<ClassifiedItem[]> {
    return items.map(
      (item): ClassifiedItem => ({
        item,
        category: this.defaultCategory,
        confidence: this.defaultConfidence,
        relevanceScore: this.defaultRelevance,
        keywords: [],
        suggestedAction: this.shouldPublish ? "publish" : "skip",
        shouldPublish: this.shouldPublish,
      })
    );
  }
}

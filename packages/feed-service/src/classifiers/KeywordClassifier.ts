/**
 * KeywordClassifier
 *
 * Local keyword-based classifier for fast, dependency-free feed item classification.
 * Uses keyword matching and simple heuristics for topic extraction.
 */

import type { IFeedClassifier } from "../interfaces/IFeedClassifier.js";
import type {
  NormalizedRSSItem,
  ClassifiedItem,
  UserContext,
} from "../types/index.js";

/**
 * Keyword category definitions
 */
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

/**
 * Keyword classifier configuration
 */
export interface KeywordClassifierConfig {
  /** Minimum confidence threshold */
  minConfidence?: number;
  /** Minimum relevance score */
  minRelevanceScore?: number;
  /** Custom keyword categories */
  categories?: KeywordCategory[];
  /** Boost factor for priority keywords */
  priorityBoost?: number;
  /** Penalty factor for exclude keywords */
  excludePenalty?: number;
}

/**
 * Default keyword categories
 */
const DEFAULT_CATEGORIES: KeywordCategory[] = [
  {
    name: "technology",
    keywords: [
      "technology",
      "tech",
      "software",
      "hardware",
      "ai",
      "artificial intelligence",
      "machine learning",
      "ml",
      "programming",
      "coding",
      "developer",
      "engineering",
      "computing",
      "cloud",
      "data",
      "algorithm",
      "automation",
      "robotics",
    ],
    relatedKeywords: [
      "innovation",
      "startup",
      "digital",
      "internet",
      "app",
      "platform",
    ],
  },
  {
    name: "business",
    keywords: [
      "business",
      "finance",
      "economy",
      "market",
      "investment",
      "startup",
      "entrepreneur",
      "company",
      "corporate",
      "revenue",
      "profit",
      "stock",
      "trading",
      "venture capital",
      "vc",
      "funding",
      "acquisition",
      "merger",
    ],
    relatedKeywords: [
      "growth",
      "strategy",
      "leadership",
      "management",
      "sales",
    ],
  },
  {
    name: "science",
    keywords: [
      "science",
      "research",
      "study",
      "scientific",
      "discovery",
      "experiment",
      "biology",
      "chemistry",
      "physics",
      "medicine",
      "health",
      "medical",
      "climate",
      "environment",
      "space",
      "astronomy",
      "genetics",
      "neuroscience",
    ],
    relatedKeywords: ["innovation", "breakthrough", "analysis", "findings"],
  },
  {
    name: "design",
    keywords: [
      "design",
      "ux",
      "ui",
      "user experience",
      "interface",
      "graphic",
      "visual",
      "creative",
      "art",
      "illustration",
      "typography",
      "branding",
      "product design",
      "web design",
      "motion",
      "animation",
    ],
    relatedKeywords: ["aesthetic", "composition", "layout", "color"],
  },
  {
    name: "politics",
    keywords: [
      "politics",
      "government",
      "policy",
      "election",
      "vote",
      "political",
      "legislation",
      "congress",
      "parliament",
      "president",
      "minister",
      "democracy",
      "republican",
      "democrat",
      "conservative",
      "liberal",
    ],
    relatedKeywords: ["law", "regulation", "campaign", "debate"],
  },
  {
    name: "entertainment",
    keywords: [
      "entertainment",
      "movie",
      "film",
      "tv",
      "television",
      "show",
      "music",
      "celebrity",
      "actor",
      "actress",
      "hollywood",
      "streaming",
      "game",
      "gaming",
      "video game",
      "concert",
      "festival",
    ],
    relatedKeywords: ["media", "culture", "pop", "viral", "trending"],
  },
  {
    name: "sports",
    keywords: [
      "sports",
      "sport",
      "football",
      "basketball",
      "soccer",
      "baseball",
      "tennis",
      "golf",
      "olympics",
      "athlete",
      "team",
      "championship",
      "league",
      "match",
      "game",
      "tournament",
      "coach",
      "player",
    ],
    relatedKeywords: ["fitness", "training", "competition", "score"],
  },
  {
    name: "lifestyle",
    keywords: [
      "lifestyle",
      "health",
      "wellness",
      "fitness",
      "food",
      "cooking",
      "travel",
      "fashion",
      "beauty",
      "home",
      "decor",
      "garden",
      "relationship",
      "family",
      "parenting",
      "self-care",
      "mindfulness",
    ],
    relatedKeywords: ["tips", "advice", "guide", "how-to"],
  },
];

/**
 * Keyword-based feed classifier
 *
 * Fast, local classification using keyword matching. No external dependencies.
 * Good for offline operation and fallback from IS classification.
 *
 * @example
 * ```typescript
 * const classifier = new KeywordClassifier({
 *   minConfidence: 0.4,
 *   categories: [...] // Custom categories
 * });
 *
 * const classified = await classifier.classify(items, {
 *   interests: ["technology", "ai"],
 *   priorityKeywords: ["startup", "funding"]
 * });
 * ```
 */
export class KeywordClassifier implements IFeedClassifier {
  private readonly config: Required<KeywordClassifierConfig>;

  constructor(config: KeywordClassifierConfig = {}) {
    this.config = {
      minConfidence: 0.4,
      minRelevanceScore: 0.3,
      categories: DEFAULT_CATEGORIES,
      priorityBoost: 0.3,
      excludePenalty: -0.5,
      ...config,
    };
  }

  /**
   * Get classifier type identifier
   */
  getClassifierType(): string {
    return "keyword";
  }

  /**
   * Classify feed items using keyword matching
   */
  async classify(
    items: NormalizedRSSItem[],
    context?: UserContext
  ): Promise<ClassifiedItem[]> {
    return items.map((item) => this.classifyItem(item, context));
  }

  /**
   * Classify a single item
   */
  private classifyItem(
    item: NormalizedRSSItem,
    context?: UserContext
  ): ClassifiedItem {
    const text = this.extractTextForClassification(item);
    const textLower = text.toLowerCase();

    // Score each category
    const scores = this.config.categories.map((category) => ({
      category,
      score: this.calculateCategoryScore(textLower, category, context),
    }));

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    const topMatch = scores[0];
    const confidence = Math.min(topMatch.score, 1);
    const relevanceScore = this.calculateRelevanceScore(
      topMatch.score,
      context,
      textLower
    );

    // Extract keywords that matched
    const matchedKeywords = this.extractMatchedKeywords(
      textLower,
      topMatch.category
    );

    return {
      item,
      category: topMatch.category.name,
      confidence,
      relevanceScore,
      keywords: matchedKeywords,
      suggestedAction: this.suggestAction(
        topMatch.category.name,
        confidence,
        relevanceScore
      ),
      shouldPublish:
        confidence >= this.config.minConfidence &&
        relevanceScore >= this.config.minRelevanceScore,
    };
  }

  /**
   * Extract text content for classification
   */
  private extractTextForClassification(item: NormalizedRSSItem): string {
    const parts = [
      item.title,
      item.summary,
      item.content?.substring(0, 2000), // Limit content length
      item.categories.join(" "),
    ].filter(Boolean);

    return parts.join(" ");
  }

  /**
   * Calculate score for a category
   */
  private calculateCategoryScore(
    text: string,
    category: KeywordCategory,
    context?: UserContext
  ): number {
    let score = 0;

    // Primary keywords (weight: 1.0)
    for (const keyword of category.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        score += 1.0;
      }
    }

    // Related keywords (weight: 0.5)
    for (const keyword of category.relatedKeywords || []) {
      if (text.includes(keyword.toLowerCase())) {
        score += 0.5;
      }
    }

    // Exclusion keywords (negative weight)
    for (const keyword of category.exclusionKeywords || []) {
      if (text.includes(keyword.toLowerCase())) {
        score -= 0.5;
      }
    }

    // Boost for priority keywords from user context
    if (context?.priorityKeywords) {
      for (const keyword of context.priorityKeywords) {
        if (text.includes(keyword.toLowerCase())) {
          score += this.config.priorityBoost;
        }
      }
    }

    // Penalty for excluded keywords
    if (context?.excludeKeywords) {
      for (const keyword of context.excludeKeywords) {
        if (text.includes(keyword.toLowerCase())) {
          score += this.config.excludePenalty;
        }
      }
    }

    // Normalize score
    const maxPossibleScore =
      category.keywords.length +
      (category.relatedKeywords?.length || 0) * 0.5 +
      (context?.priorityKeywords?.length || 0) * this.config.priorityBoost;

    return maxPossibleScore > 0 ? score / maxPossibleScore : 0;
  }

  /**
   * Calculate relevance score based on category and context
   */
  private calculateRelevanceScore(
    categoryScore: number,
    context?: UserContext,
    text?: string
  ): number {
    let relevance = categoryScore;

    // Boost if category matches user interests
    if (context?.interests && text) {
      const textLower = text.toLowerCase();
      const matchingInterests = context.interests.filter((interest) =>
        textLower.includes(interest.toLowerCase())
      );

      if (matchingInterests.length > 0) {
        relevance +=
          (matchingInterests.length / context.interests.length) * 0.3;
      }
    }

    // Boost if matches preferred categories
    if (context?.preferredCategories && text) {
      const categoryMatch = context.preferredCategories.some((cat) =>
        text?.toLowerCase().includes(cat.toLowerCase())
      );

      if (categoryMatch) {
        relevance += 0.2;
      }
    }

    // Apply calibration if available
    if (context?.calibrationScores) {
      const scores = Object.values(context.calibrationScores) as number[];
      const avgCalibration =
        scores.reduce((sum: number, score: number) => sum + score, 0) /
        scores.length;

      relevance = relevance * 0.7 + avgCalibration * 0.3;
    }

    return Math.min(Math.max(relevance, 0), 1);
  }

  /**
   * Extract keywords that matched
   */
  private extractMatchedKeywords(
    text: string,
    category: KeywordCategory
  ): string[] {
    const matched: string[] = [];

    for (const keyword of category.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        matched.push(keyword);
      }
    }

    return matched.slice(0, 5); // Limit to top 5
  }

  /**
   * Suggest an action based on classification
   */
  private suggestAction(
    category: string,
    confidence: number,
    relevance: number
  ): string {
    if (confidence < 0.3) {
      return "review";
    }

    if (relevance > 0.8) {
      return "notify";
    }

    if (category === "technology" || category === "business") {
      return "save";
    }

    if (category === "entertainment" || category === "sports") {
      return "skip"; // Lower priority
    }

    return "publish";
  }
}

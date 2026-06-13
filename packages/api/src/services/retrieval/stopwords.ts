/**
 * Shared stopword vocabulary for the retrieval engine, so the query-understanding
 * property-value filter and the rekey corrector can't drift apart.
 */

/** Function words that carry no retrieval signal on their own. */
export const COMMON_STOPWORDS = new Set([
  "is",
  "are",
  "was",
  "were",
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "and",
]);

/** Interrogatives — stripped when reducing a query to content keywords. */
export const QUESTION_WORDS = new Set([
  "who",
  "what",
  "when",
  "where",
  "which",
  "whose",
  "whom",
  "why",
  "how",
]);

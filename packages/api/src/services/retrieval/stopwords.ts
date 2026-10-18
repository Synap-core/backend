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

/**
 * The conversational frame of a question — pronouns, auxiliary and modal verbs,
 * and the contractions a term sanitizer flattens ("I'm" → "im"). "I am changing
 * a page, how do I check its flows?" is about changing, page, check, flows;
 * never about i, am, do, its.
 *
 * Kept apart from COMMON_STOPWORDS so the consumers of that set keep their
 * behaviour; the procedural recall lane needs it because it prefix-matches
 * every term, so a kept `i` becomes `i:*` and hits every word starting with i.
 */
export const CONVERSATIONAL_WORDS = new Set([
  "i",
  "im",
  "ive",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "it",
  "its",
  "they",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "am",
  "be",
  "been",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "can",
  "could",
  "should",
  "would",
  "will",
  "at",
  "by",
  "from",
  "into",
  "about",
  "as",
  "or",
  "if",
  "so",
  "but",
  "not",
]);

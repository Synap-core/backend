/**
 * Is this query a QUESTION? The one cue a find surface reads to start the
 * pod's answer (`knowledge.answer`) beside the find rows, in parallel, only
 * when it is worth spending a model on.
 *
 * Deterministic, no classifier (decisions 38fbd283, 47d56eb0, 52b5acfc): the
 * first word is an interrogative, or the query ends with "?". The word list is
 * the retrieval engine's existing interrogatives (`QUESTION_WORDS`), which
 * lived in the api's `services/retrieval/stopwords.ts`; it lives HERE now and
 * the api re-exports it, so query understanding and every client read one
 * list.
 */

/** Interrogatives: stripped when reducing a query to content keywords. */
export const QUESTION_WORDS: ReadonlySet<string> = new Set([
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

/** True when the first word is an interrogative or the query ends with "?". */
export function isQuestion(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith("?")) return true;
  const first = trimmed
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find(Boolean);
  return first !== undefined && QUESTION_WORDS.has(first);
}

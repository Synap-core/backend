/**
 * CRAG-style corrective grader (Phase 4) — lightweight, model-free.
 *
 * Scores the retrieved set against the query understanding and emits a verdict
 * (for glass-box observability) plus, when warranted, a cheap corrective action.
 * We deliberately keep this honest: our fusion already protects recall via the
 * unscoped baseline, so the only correction that does real work is re-keying an
 * EMPTY result set (re-query lexically when the natural-language phrasing found
 * nothing). "ambiguous" is reported but needs no re-run — the unscoped baseline
 * already carries general results.
 *
 * See team/platform/retrieval-architecture.mdx, Phase 4.
 */
import type { QueryUnderstanding } from "./understand-query.js";
import { COMMON_STOPWORDS, QUESTION_WORDS } from "./stopwords.js";

export type RetrievalVerdict = "confident" | "ambiguous" | "empty";
export type Correction = "none" | "rekey";

export interface Grade {
  verdict: RetrievalVerdict;
  reason: string;
  correction: Correction;
}

/**
 * Grade a result set. `resultTypes` is each result's entity type in rank order.
 */
export function gradeResults(
  understanding: QueryUnderstanding,
  resultTypes: string[]
): Grade {
  if (resultTypes.length === 0) {
    return {
      verdict: "empty",
      reason: "no results — retrying with extracted keywords",
      correction: "rekey",
    };
  }
  const { profileTypes } = understanding;
  if (profileTypes.length > 0) {
    const top = resultTypes.slice(0, 3);
    if (!top.some((t) => profileTypes.includes(t))) {
      // We confidently inferred a type, but no top-3 result IS that type — the
      // type-scoped passes found nothing, so the top is unscoped general recall.
      // Report it (the unscoped baseline already protects recall; no re-run).
      return {
        verdict: "ambiguous",
        reason: `inferred type [${profileTypes.join(", ")}] not in top results`,
        correction: "none",
      };
    }
  }
  return {
    verdict: "confident",
    reason: "top results match intent",
    correction: "none",
  };
}

const REKEY_STOP = new Set([
  ...COMMON_STOPWORDS,
  ...QUESTION_WORDS,
  // extra conversational fillers specific to reducing a query to keywords
  "or",
  "do",
  "did",
  "does",
  "my",
  "our",
  "we",
  "i",
  "me",
  "about",
  "that",
  "this",
  "it",
  "at",
  "by",
  "from",
  "as",
  "be",
]);

/**
 * Reduce a natural-language query to its content keywords for the "rekey"
 * correction — strips question words + stopwords so a lexical re-query can hit
 * when the full phrasing buried the signal. Returns "" if nothing remains
 * (caller should then keep the original empty result).
 */
export function rekey(query: string): string {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !REKEY_STOP.has(w))
    .join(" ")
    .trim();
}

/**
 * The ONE lexical term matcher — skills search (SQL, `services/skills/search.ts`)
 * and capability search (in memory, `rankByTerms` in `capability-registry.ts`,
 * the containers route and the catalog cache) both rank through here. One tokenizer, one stemmer, one
 * stopword list, one points table, one rarity weight. Two adapters exist only
 * because one catalog lives in Postgres and the other is assembled in JS; the
 * parity test (`services/skills/__tests__/skill-ranking.pglite.test.ts`) drives
 * the same fixtures through both and asserts the same order.
 *
 * ── SCORING ────────────────────────────────────────────────────────────────
 * Per term, per candidate: `TERM_POINTS.hit` for any hit, plus where it hit —
 * primary exact > primary substring > secondary > tertiary. The term's points
 * are multiplied by its RARITY WEIGHT over the candidate set, and summed.
 *
 * ── RARITY ─────────────────────────────────────────────────────────────────
 * Each term is weighted by `ln(1 + N/df)` over the GATED candidate set, so a
 * distinctive word outranks a generic one, and rows a caller cannot see never
 * move the ranking.
 *
 * This is lexical, not semantic. Case folding is JS `toLowerCase` on one side
 * and `ILIKE`/`lower()` on the other; they agree on ASCII, which is every slug
 * and nearly every name — non-ASCII case folding may differ at the margin.
 */
import { drizzleSql, type SQL } from "@synap/database";

/** Bounds the generated SQL; a query past this many terms is not a search. */
export const MAX_QUERY_TERMS = 8;

const STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
  "to",
  "use",
  "using",
  "want",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you",
  "your",
]);

function stem(word: string): string {
  // Only plain words: a slug-ish token (`gmail_send`, `100%`) stays verbatim.
  if (!/^[a-z]+$/.test(word)) return word;
  // A trailing `e` goes too, so "create" still reaches "creator"/"creating".
  for (const suffix of ["ing", "ies", "ed", "es", "s", "e"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      const base = word.slice(0, -suffix.length);
      return suffix === "ies" ? `${base}y` : base;
    }
  }
  return word;
}

/**
 * The search terms for `q`. A query made only of stopwords ("how to") still
 * searches those words rather than silently matching everything; a query made
 * only of punctuation searches it literally. Terms never contain whitespace.
 */
export function queryTerms(q: string): string[] {
  const trimmed = q.trim().toLowerCase();
  if (!trimmed) return [];
  const words = trimmed.split(/[\s,.;:!?()"'`[\]{}]+/).filter(Boolean);
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  const chosen = meaningful.length > 0 ? meaningful : words;
  const terms =
    chosen.length > 0 ? chosen.map(stem) : [trimmed.replace(/\s+/g, "")];
  return [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
}

/** Points one term earns on one candidate, by where it hit. */
export const TERM_POINTS = {
  hit: 100,
  primaryExact: 20,
  primary: 10,
  secondary: 5,
  tertiary: 1,
} as const;

/**
 * Smoothed inverse document frequency over the candidate set. `0` when the
 * term hits nothing (it then contributes nothing to any score).
 */
export function rarityWeight(candidateCount: number, docFreq: number): number {
  if (docFreq <= 0 || candidateCount <= 0) return 0;
  return Math.log(1 + candidateCount / docFreq);
}

// ── JS adapter ───────────────────────────────────────────────────────────────

/** The searchable text of one candidate, weighted by field. */
export interface MatchableText {
  /** Highest weight — e.g. a name (and slug). An exact value scores highest. */
  primary: string | readonly string[];
  /** Medium weight — e.g. verb labels, member names, topics/tags. */
  secondary?: readonly string[];
  /** Lowest weight — e.g. a free-text description. */
  tertiary?: string | null;
}

interface NormalizedText {
  primary: string[];
  secondary: string[];
  tertiary: string;
}

function normalize(target: MatchableText): NormalizedText {
  const primary =
    typeof target.primary === "string" ? [target.primary] : target.primary;
  return {
    primary: primary.map((p) => (p ?? "").toLowerCase()),
    secondary: (target.secondary ?? []).map((s) => (s ?? "").toLowerCase()),
    tertiary: (target.tertiary ?? "").toLowerCase(),
  };
}

function hitsFor(term: string, t: NormalizedText) {
  return {
    primary: t.primary.some((p) => p.includes(term)),
    secondary: t.secondary.some((s) => s.includes(term)),
    tertiary: t.tertiary.includes(term),
  };
}

function pointsFor(term: string, t: NormalizedText): number {
  const { primary, secondary, tertiary } = hitsFor(term, t);
  if (!primary && !secondary && !tertiary) return 0;
  const exact = t.primary.some((p) => p === term);
  return (
    TERM_POINTS.hit +
    (exact ? TERM_POINTS.primaryExact : primary ? TERM_POINTS.primary : 0) +
    (secondary ? TERM_POINTS.secondary : 0) +
    (tertiary ? TERM_POINTS.tertiary : 0)
  );
}

/**
 * Score ONE candidate with every term weighted equally — for a caller that has
 * no candidate set to measure rarity over. Returns 0 when no term matches
 * (callers exclude / rank last on 0). Prefer {@link rankByTerms} when ranking
 * a list: it applies rarity.
 */
export function scoreTextMatch(query: string, target: MatchableText): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const t = normalize(target);
  return terms.reduce((sum, term) => sum + pointsFor(term, t), 0);
}

/**
 * Rank `candidates` against `query` with rarity weighting measured over
 * `candidates` itself (so pass the list AFTER every gate/filter). Zero-score
 * candidates are dropped; ties keep their input order (stable sort).
 */
export function rankByTerms<T>(
  query: string,
  candidates: readonly T[],
  fieldsOf: (candidate: T) => MatchableText,
  labels: TermFieldLabels = DEFAULT_FIELD_LABELS
): Array<{ item: T; score: number; match: TermMatch }> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const texts = candidates.map((c) => normalize(fieldsOf(c)));
  const points = terms.map((term) => texts.map((t) => pointsFor(term, t)));
  const weights = points.map((perCandidate) =>
    rarityWeight(candidates.length, perCandidate.filter((p) => p > 0).length)
  );
  return candidates
    .map((item, j) => ({
      item,
      score: terms.reduce((sum, _, i) => sum + weights[i]! * points[i]![j]!, 0),
      text: texts[j]!,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item, score, text }) => ({
      item,
      score,
      match: explainNormalized(terms, weights, text, labels),
    }));
}

/**
 * Why a candidate matched, for an agent choosing between results: the query
 * terms it hit, rarest (highest-weighted) first, and the fields they hit.
 */
export interface TermMatch {
  terms: string[];
  fields: string[];
}

/** Wire names for the three field tiers — each door names its own. */
export interface TermFieldLabels {
  primary: string;
  secondary: string;
  tertiary: string;
}

const DEFAULT_FIELD_LABELS: TermFieldLabels = {
  primary: "name",
  secondary: "labels",
  tertiary: "description",
};

function explainNormalized(
  terms: readonly string[],
  weights: readonly number[],
  text: NormalizedText,
  labels: TermFieldLabels
): TermMatch {
  const hit = terms
    .map((term, i) => ({
      term,
      weight: weights[i] ?? 0,
      ...hitsFor(term, text),
    }))
    .filter((h) => h.primary || h.secondary || h.tertiary)
    .sort((a, b) => b.weight - a.weight);
  const tiers = (["primary", "secondary", "tertiary"] as const).filter((tier) =>
    hit.some((h) => h[tier])
  );
  return { terms: hit.map((h) => h.term), fields: tiers.map((t) => labels[t]) };
}

/**
 * {@link TermMatch} for one row whose weights were measured elsewhere (the SQL
 * adapter measures them over its gated set). Same hit rule as the score.
 */
export function explainTermMatch(
  terms: readonly string[],
  weights: readonly number[],
  target: MatchableText,
  labels: TermFieldLabels = DEFAULT_FIELD_LABELS
): TermMatch {
  return explainNormalized(terms, weights, normalize(target), labels);
}

// ── SQL adapter ──────────────────────────────────────────────────────────────

/** The searchable text of a row, as SQL expressions (nullable is fine). */
export interface SqlMatchableText {
  /** `text` expressions — e.g. name, slug. */
  primary: readonly SQL[];
  /** One `text[]` expression — e.g. `topics || tags`. */
  secondary?: SQL;
  /** One `text` expression — e.g. description. */
  tertiary?: SQL;
}

export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

export interface SqlTermMatch {
  /** Per term, TRUE when the row hits it — for `count(*) FILTER (WHERE …)`. */
  hits: SQL[];
  /** TRUE when the row hits ANY term — the match filter. */
  anyHit: SQL;
  /** The score expression, given one rarity weight per term (same order). */
  score(weights: readonly number[]): SQL;
}

const int = (n: number) => drizzleSql.raw(String(Math.trunc(n)));

/**
 * The SQL twin of {@link rankByTerms}. The caller measures rarity over its own
 * gated candidate set (`count(*)` and `count(*) FILTER (WHERE hits[i])`), feeds
 * those through {@link rarityWeight}, and orders by `score(weights)`. User
 * input is bound as parameters and LIKE-escaped: `%` and `_` are literal.
 */
export function sqlTermMatch(
  terms: readonly string[],
  fields: SqlMatchableText
): SqlTermMatch {
  const hits: SQL[] = [];
  const points: SQL[] = [];
  for (const term of terms) {
    const pattern = `%${escapeLike(term)}%`;
    const inPrimary = drizzleSql`(${drizzleSql.join(
      fields.primary.map(
        (p) => drizzleSql`coalesce(${p}, '') ILIKE ${pattern} ESCAPE '\\'`
      ),
      drizzleSql` OR `
    )})`;
    const primaryExact = drizzleSql`(${drizzleSql.join(
      fields.primary.map(
        (p) => drizzleSql`lower(coalesce(${p}, '')) = ${term}`
      ),
      drizzleSql` OR `
    )})`;
    const inSecondary = fields.secondary
      ? drizzleSql`(EXISTS (SELECT 1 FROM unnest(coalesce(${fields.secondary}, '{}'::text[])) AS label WHERE label ILIKE ${pattern} ESCAPE '\\'))`
      : drizzleSql`FALSE`;
    const inTertiary = fields.tertiary
      ? drizzleSql`(coalesce(${fields.tertiary}, '') ILIKE ${pattern} ESCAPE '\\')`
      : drizzleSql`FALSE`;
    const hit = drizzleSql`(${inPrimary} OR ${inSecondary} OR ${inTertiary})`;
    hits.push(hit);
    points.push(
      drizzleSql`(CASE WHEN ${hit} THEN ${int(TERM_POINTS.hit)} ELSE 0 END + CASE WHEN ${primaryExact} THEN ${int(TERM_POINTS.primaryExact)} WHEN ${inPrimary} THEN ${int(TERM_POINTS.primary)} ELSE 0 END + CASE WHEN ${inSecondary} THEN ${int(TERM_POINTS.secondary)} ELSE 0 END + CASE WHEN ${inTertiary} THEN ${int(TERM_POINTS.tertiary)} ELSE 0 END)`
    );
  }
  return {
    hits,
    anyHit: drizzleSql`(${drizzleSql.join(hits, drizzleSql` OR `)})`,
    score(weights) {
      return drizzleSql`(${drizzleSql.join(
        points.map((p, i) => {
          const w = weights[i] ?? 0;
          // A JS-computed finite double, never user input.
          const literal = Number.isFinite(w) ? w : 0;
          return drizzleSql`(${drizzleSql.raw(String(literal))}::double precision * ${p})`;
        }),
        drizzleSql` + `
      )})`;
    },
  };
}

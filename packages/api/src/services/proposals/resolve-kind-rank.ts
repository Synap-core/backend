/**
 * Which OTHER kind a waiting graph item could be filed as, when its own kind
 * is not available where it lands (`kind_missing`) — the `use_kind`
 * suggestions `proposals.resolveOptions` offers ("File it as another kind:
 * Research · Finding · Note").
 *
 * Pure and classifier-free: every signal is read from what the pod already
 * stores on a kind (slug, display name, plural, `synonyms`, `semanticSlug`,
 * its fields), never from a model. Ranked by four tiers, compared in order
 * (PROPOSAL-FAILURES-YOU-CAN-RESOLVE plan, A2):
 *
 *  1. `sameSlug`   — the candidate IS the missing slug (it became available
 *                    here, e.g. after its scope was widened).
 *  2. `vocabulary` — the curated words the pod's recall already uses
 *                    (`understand-query.ts`): a candidate whose `synonyms`
 *                    name the missing kind, the missing kind's `synonyms`
 *                    naming the candidate, or a shared `semanticSlug`.
 *  3. `fieldOverlap` — the share of the item's property keys the candidate
 *                    has as fields (0..1).
 *  4. `similarity` — how close the names are (bigram overlap of the kind
 *                    names), or the candidate's name appearing in the item's
 *                    title.
 *
 * A candidate no tier scores is not suggested: an unranked list of every kind
 * is not a suggestion. LIMITS, stated: field overlap reads only the fields a
 * kind declares itself (not inherited ones — the loader passes what it read),
 * and names are compared as words, so "Insight" and "Finding" never match
 * unless a synonym says so.
 */

export interface MissingKindSignal {
  /** The slug the item named. */
  slug: string;
  /** Its display name where it exists, when known. */
  kindName?: string;
  /** The missing kind's own vocabulary, read from where it exists. */
  synonyms?: readonly string[] | null;
  semanticSlug?: string | null;
}

export interface KindCandidate {
  slug: string;
  displayName: string;
  plural?: string | null;
  synonyms?: readonly string[] | null;
  semanticSlug?: string | null;
  /** The candidate's field slugs. */
  fieldSlugs: readonly string[];
}

export interface KindSuggestionSignals {
  sameSlug: boolean;
  vocabulary: boolean;
  /** 0..1 — share of the item's property keys the candidate has. */
  fieldOverlap: number;
  /** 0..1 — name closeness, or 0.5 when the candidate is named in the title. */
  similarity: number;
}

export interface KindSuggestion {
  slug: string;
  displayName: string;
  signals: KindSuggestionSignals;
}

/** How close two names must be before closeness alone suggests a kind. */
export const NAME_SIMILARITY_FLOOR = 0.5;
/** What the candidate's name appearing in the item's title is worth. */
const TITLE_HIT = 0.5;

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Singular-tolerant word form: "trends" → "trend". */
const stem = (w: string): string =>
  w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;

const words = (s: string): string[] =>
  norm(s)
    .split(" ")
    .filter((w) => w.length > 0)
    .map(stem);

function sameWord(a: string, b: string): boolean {
  const x = words(a).join(" ");
  const y = words(b).join(" ");
  return x.length > 0 && x === y;
}

function bigrams(s: string): string[] {
  const t = words(s).join(" ");
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice over character bigrams, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.length === 0 || y.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const g of y) pool.set(g, (pool.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of x) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      shared++;
      pool.set(g, n - 1);
    }
  }
  return (2 * shared) / (x.length + y.length);
}

function namesOf(c: KindCandidate): string[] {
  return [c.slug, c.displayName, ...(c.plural ? [c.plural] : [])];
}

export function scoreKindCandidate(
  missing: MissingKindSignal,
  item: { title?: string; propertyKeys: readonly string[] },
  c: KindCandidate
): KindSuggestionSignals {
  const missingNames = [
    missing.slug,
    ...(missing.kindName ? [missing.kindName] : []),
  ];
  const sameSlug = c.slug === missing.slug;

  const candidateSynonymsNameMissing = (c.synonyms ?? []).some((s) =>
    missingNames.some((m) => sameWord(s, m))
  );
  const missingSynonymsNameCandidate = (missing.synonyms ?? []).some((s) =>
    namesOf(c).some((n) => sameWord(s, n))
  );
  const sharedSemantic =
    !!c.semanticSlug &&
    (c.semanticSlug === missing.semanticSlug ||
      c.semanticSlug === missing.slug);
  const vocabulary =
    candidateSynonymsNameMissing ||
    missingSynonymsNameCandidate ||
    sharedSemantic;

  const keys = [...new Set(item.propertyKeys.map((k) => norm(k)))].filter(
    (k) => k.length > 0
  );
  const fields = new Set(c.fieldSlugs.map((f) => norm(f)));
  const fieldOverlap =
    keys.length === 0
      ? 0
      : keys.filter((k) => fields.has(k)).length / keys.length;

  let similarity = 0;
  for (const m of missingNames) {
    for (const n of namesOf(c)) {
      similarity = Math.max(similarity, nameSimilarity(m, n));
    }
  }
  if (similarity < NAME_SIMILARITY_FLOOR) similarity = 0;
  if (item.title) {
    const titleWords = new Set(words(item.title));
    const named = namesOf(c).some((n) => {
      const ws = words(n).filter((w) => w.length > 3);
      return ws.length > 0 && ws.every((w) => titleWords.has(w));
    });
    if (named) similarity = Math.max(similarity, TITLE_HIT);
  }

  return { sameSlug, vocabulary, fieldOverlap, similarity };
}

function scored(s: KindSuggestionSignals): boolean {
  return s.sameSlug || s.vocabulary || s.fieldOverlap > 0 || s.similarity > 0;
}

/** Tier order: sameSlug, then vocabulary, then field overlap, then names. */
export function compareSignals(
  a: KindSuggestionSignals,
  b: KindSuggestionSignals
): number {
  if (a.sameSlug !== b.sameSlug) return a.sameSlug ? -1 : 1;
  if (a.vocabulary !== b.vocabulary) return a.vocabulary ? -1 : 1;
  if (a.fieldOverlap !== b.fieldOverlap) return b.fieldOverlap - a.fieldOverlap;
  return b.similarity - a.similarity;
}

/** The ranked suggestions — only candidates some tier scores, best first. */
export function rankKindSuggestions(args: {
  missing: MissingKindSignal;
  item: { title?: string; propertyKeys: readonly string[] };
  candidates: readonly KindCandidate[];
  limit?: number;
}): KindSuggestion[] {
  const seen = new Set<string>();
  const out: KindSuggestion[] = [];
  for (const c of args.candidates) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    const signals = scoreKindCandidate(args.missing, args.item, c);
    if (scored(signals)) {
      out.push({ slug: c.slug, displayName: c.displayName, signals });
    }
  }
  out.sort(
    (a, b) =>
      compareSignals(a.signals, b.signals) ||
      a.displayName.localeCompare(b.displayName)
  );
  return out.slice(0, args.limit ?? 3);
}

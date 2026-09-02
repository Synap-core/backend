/**
 * Query understanding — the System-1 "structured signal" of the Synap Retrieval
 * Engine (see team/platform/retrieval-architecture.mdx, Phase 1).
 *
 * Pure + deterministic: given a natural-language query and the workspace's real
 * profile catalog, infer the target entity TYPE(s) and soft property hints. This
 * is the fix for the dogfood failure where hybrid recall ranked the correct
 * entity at rank 4–10 (and missed at K=3) because it ignored entity type — e.g.
 * "who is the VP of Product" → the `person` profile; "what did we decide" → the
 * `decision` profile. Type-scoped recall then boosts those to rank 1.
 *
 * No LLM round-trip: heuristics grounded in the ACTUAL catalog (we never assume a
 * profile named "person" exists — we match the cue against the workspace's real
 * profiles). The IS can refine ambiguous cases in a later phase.
 */

import { COMMON_STOPWORDS, QUESTION_WORDS } from "./stopwords.js";

export interface ProfileCatalogEntry {
  slug: string;
  displayName: string;
  description?: string;
  /** The display name's plural form ("people" for Person). Data-driven (0197). */
  plural?: string | null;
  /** Alternate words that resolve to this profile ("who", "contact" → person). */
  synonyms?: string[] | null;
}

/**
 * Map a raw profile row to a catalog entry, carrying its query-understanding
 * vocabulary. Returns null for a slug-less row (filtered by callers). ONE door
 * so every `ask`/`retrieve` caller builds the catalog identically — including
 * the plural/synonyms the type inference now consumes.
 */
export function toProfileCatalogEntry(p: {
  slug?: string | null;
  displayName?: string | null;
  plural?: string | null;
  synonyms?: string[] | null;
}): ProfileCatalogEntry | null {
  if (!p.slug) return null;
  return {
    slug: p.slug,
    displayName: p.displayName ?? p.slug,
    ...(p.plural ? { plural: p.plural } : {}),
    ...(p.synonyms && p.synonyms.length > 0 ? { synonyms: p.synonyms } : {}),
  };
}

export interface PropertyHint {
  /** Token(s) to match against an entity's serialized properties. */
  value: string;
  /** Optional property key the hint targets (e.g. "role"); undefined = any key. */
  key?: string;
}

export interface QueryUnderstanding {
  /** Inferred target profile slugs, most-likely first (may be empty). */
  profileTypes: string[];
  /** Soft property/value hints used to boost ranking (never a hard filter). */
  propertyHints: PropertyHint[];
  /** True when the query implies recency/temporal scope. */
  temporal: boolean;
  /** 0..1 confidence in the type inference. */
  confidence: number;
  /**
   * The query with type/vocabulary words removed — the residual free-text a
   * routed listing should still be filtered by. Strips the matched type words
   * (slug/name/plural/synonym/KIND_CUE tokens that produced the profileType
   * hits), the property-hint value tokens, and enumerative/function framing
   * ("show all …", "who", "the"). "show all people" → "" (the type is the whole
   * intent); "acme people" → "acme". Empty string when nothing remains. Order
   * and casing of the surviving words are preserved. This is the contract
   * clients consume to split a query into {type, freeText}.
   */
  cleanedQuery: string;
}

/**
 * Interrogative / lexical cues → a canonical "kind". Each kind is matched against
 * the workspace's REAL profiles by slug/name resemblance; a cue with no matching
 * profile contributes nothing.
 */
export const KIND_CUES: Record<string, string[]> = {
  person: [
    "who",
    "whom",
    "person",
    "people",
    "contact",
    "colleague",
    "someone",
  ],
  // NB: "client" and "lead" are deliberately NOT cues — in Synap's CRM model
  // `client` is its own profile (post-win relationship) and `lead` is a deal
  // STAGE, not a synonym. A direct catalog match (score 3) still resolves them.
  company: [
    "company",
    "companies",
    "org",
    "organization",
    "organisation",
    "vendor",
    "employer",
    "firm",
  ],
  event: [
    "when",
    "event",
    "meeting",
    "call",
    "appointment",
    "kickoff",
    "review",
  ],
  task: [
    "task",
    "todo",
    "to-do",
    "due",
    "deadline",
    "deliverable",
    "assignment",
    "action item",
  ],
  decision: [
    "decide",
    "decided",
    "decision",
    "chose",
    "chosen",
    "agreed",
    "concluded",
    "resolved",
  ],
  project: ["project", "initiative", "epic", "milestone"],
  note: ["note", "thought", "idea", "memo"],
  document: ["doc", "document", "report", "spec", "paper", "memo"],
  deal: ["deal", "opportunity", "pipeline"],
};

/**
 * Single-word KIND_CUES vocabulary — the type-noun words themselves ("people",
 * "company", "task"). Stripped from `cleanedQuery` whether or not a catalog
 * profile matched, so the no-vocabulary fallback still reduces "show all people"
 * to "" (the residual filter is empty). Multi-word cues are skipped to avoid
 * fragmenting common words ("action item" → "action").
 */
const KIND_CUE_WORDS = new Set(
  Object.values(KIND_CUES)
    .flat()
    .filter((c) => /^[a-z]+$/.test(c))
);

/**
 * Enumerative / imperative framing words ("show all …", "list my …") plus
 * function words and interrogatives — filler that frames a request but carries
 * no filter signal. Stripped from `cleanedQuery` alongside the matched type
 * words, leaving only the residual free-text a listing is filtered by.
 */
const CLEANED_QUERY_FILLER = new Set<string>([
  ...COMMON_STOPWORDS,
  ...QUESTION_WORDS,
  "show",
  "list",
  "find",
  "get",
  "give",
  "see",
  "display",
  "all",
  "me",
  "my",
  "our",
  "your",
  "their",
  "any",
  "some",
  "every",
]);

/** Role keywords worth surfacing as a property hint (targets a `role` property). */
const ROLE_KEYWORDS = [
  "vp",
  "ceo",
  "cto",
  "cfo",
  "coo",
  "founder",
  "director",
  "manager",
  "head",
  "lead",
  "president",
  "chief",
  "engineer",
  "designer",
];

// RECENCY cues only. The temporal signal scores by last-activity (event chain /
// updatedAt), so it serves "what changed / latest / recently active". Due-date
// cues (due/overdue/upcoming/by Friday) are deliberately EXCLUDED — they need a
// `properties.dueDate` proximity signal (a later phase + the /entities date-range
// filter), and claiming them here would apply a recency boost that's irrelevant
// (or backwards) for "what's overdue".
const TEMPORAL_RE =
  /\b(recent|recently|latest|newest|changed|last (week|month|year|night|quarter)|yesterday|today|tonight|this (week|month|quarter|year)|since)\b/;

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function extractPropertyHints(query: string): PropertyHint[] {
  const hints: PropertyHint[] = [];
  const lower = query.toLowerCase();
  const tokens = new Set(tokenize(query));

  // role: keyword (e.g. "VP of Product" → role hint "vp")
  for (const role of ROLE_KEYWORDS) {
    if (tokens.has(role)) hints.push({ key: "role", value: role });
  }

  // "key value" patterns with any connector or just whitespace: "status done",
  // "status: done", "priority = high", "role is manager". Skip stopword values
  // so "role of the manager" doesn't capture "of".
  for (const m of lower.matchAll(
    /\b(status|priority|stage|role|assignee|owner)\b[:=\s]+([a-z0-9-]+)/g
  )) {
    if (!COMMON_STOPWORDS.has(m[2])) hints.push({ key: m[1], value: m[2] });
  }

  // quoted phrases are strong hints
  for (const m of query.matchAll(/"([^"]{2,40})"/g)) {
    hints.push({ value: m[1] });
  }

  // de-dup
  const seen = new Set<string>();
  return hints.filter((h) => {
    const k = `${h.key ?? ""}:${h.value.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function understandQuery(
  query: string,
  catalog: ProfileCatalogEntry[]
): QueryUnderstanding {
  const q = query.toLowerCase().trim();
  const tokenSet = new Set(tokenize(q));

  const scored = new Map<string, number>(); // slug → score
  const bump = (slug: string, by: number) =>
    scored.set(slug, (scored.get(slug) ?? 0) + by);

  // The catalog signals that produced each slug's hit — the words removed from
  // cleanedQuery once we know which slugs made the final cut. Stored tokenized
  // (multi-word names/synonyms split) so removal is per-word + plural-tolerant.
  const termsBySlug = new Map<string, Set<string>>();
  const addTerms = (slug: string, terms: Iterable<string>) => {
    let set = termsBySlug.get(slug);
    if (!set) {
      set = new Set();
      termsBySlug.set(slug, set);
    }
    for (const t of terms) for (const w of tokenize(t)) set.add(w);
  };

  // Plural-tolerant match of a single cue term against the query: a multi-word
  // phrase must appear verbatim; a single word matches its singular or plural
  // form. Mirrors the KIND_CUES matcher so catalog synonyms behave identically.
  const cueHit = (term: string): boolean => {
    const t = term.toLowerCase();
    if (t.includes(" ")) return q.includes(t);
    return (
      tokenSet.has(t) ||
      tokenSet.has(`${t}s`) ||
      tokenSet.has(t.replace(/s$/, ""))
    );
  };

  // 1. Direct catalog match — the query names the profile (slug, display name,
  //    its declared plural, or a declared synonym).
  for (const p of catalog) {
    const name = p.displayName.toLowerCase();
    const slug = p.slug.toLowerCase();
    const plural = p.plural?.toLowerCase();
    // Strong (3): the query names the profile — slug/name as a substring, or the
    // declared plural as a substring or plural-tolerant token ("people").
    if (
      q.includes(slug) ||
      q.includes(name) ||
      (plural ? q.includes(plural) || cueHit(plural) : false)
    ) {
      bump(p.slug, 3);
      addTerms(p.slug, plural ? [slug, name, plural] : [slug, name]);
      continue;
    }
    // A declared synonym is curated, catalog-grounded vocabulary — the
    // data-driven form of a KIND_CUE, and a strong signal ("who" → person).
    if ((p.synonyms ?? []).some(cueHit)) {
      bump(p.slug, 3);
      addTerms(p.slug, p.synonyms ?? []);
      continue;
    }
    // singular/plural-tolerant: strip a trailing "s" from both sides of token match
    const nameWords = tokenize(name);
    const matchedNameWords = nameWords.filter(
      (w) =>
        w.length > 3 &&
        (tokenSet.has(w) ||
          tokenSet.has(`${w}s`) ||
          tokenSet.has(w.replace(/s$/, "")))
    );
    if (matchedNameWords.length > 0) {
      bump(p.slug, 2);
      addTerms(p.slug, matchedNameWords);
    }
  }

  // 2. Kind cues → map a canonical kind to the catalog profile that resembles it.
  for (const [kind, cues] of Object.entries(KIND_CUES)) {
    const cued = cues.some((c) =>
      c.includes(" ") ? q.includes(c) : tokenSet.has(c)
    );
    if (!cued) continue;
    const match = catalog.find(
      (p) =>
        p.slug.toLowerCase().includes(kind) ||
        p.displayName.toLowerCase().includes(kind)
    );
    if (match) {
      bump(match.slug, 2);
      addTerms(
        match.slug,
        cues.filter((cue) => !cue.includes(" "))
      );
    }
  }

  const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]);
  const topScore = ranked[0]?.[1] ?? 0;
  // Keep types that scored at least a kind-cue's worth (2); cap at 3 to stay focused.
  const profileTypes = ranked
    .filter(([, s]) => s >= 2)
    .slice(0, 3)
    .map(([slug]) => slug);

  // Normalize the top score to 0..1. Max realistic score is 5 (direct catalog
  // match 3 + a kind cue 2); a direct match alone (3) → 0.75. Bump the scale and
  // the scoring weights move together, keeping confidence auditable.
  const CONFIDENCE_SCALE = 4;

  const propertyHints = extractPropertyHints(query);

  // cleanedQuery: the original words minus (a) the type words that produced the
  // FINAL profileTypes, (b) the property-hint value tokens, (c) the type-noun
  // vocabulary (KIND_CUES) even when no catalog profile matched — the
  // no-vocabulary fallback, and (d) enumerative/function framing. Matching is
  // plural-tolerant; the surviving words keep their original order and casing.
  const removal = new Set<string>();
  for (const slug of profileTypes) {
    for (const w of termsBySlug.get(slug) ?? []) removal.add(w);
  }
  for (const h of propertyHints)
    for (const w of tokenize(h.value)) removal.add(w);
  const norm = (w: string) => w.replace(/s$/, "");
  const normRemoval = new Set([...removal].map(norm));
  const isStripped = (key: string): boolean =>
    CLEANED_QUERY_FILLER.has(key) ||
    KIND_CUE_WORDS.has(key) ||
    KIND_CUE_WORDS.has(norm(key)) ||
    removal.has(key) ||
    normRemoval.has(norm(key));

  const cleanedQuery = query
    .split(/\s+/)
    .map((raw) => ({ raw, key: raw.toLowerCase().replace(/[^a-z0-9]+/g, "") }))
    .filter(({ key }) => key.length > 0 && !isStripped(key))
    .map(({ raw }) => raw)
    .join(" ")
    .trim();

  return {
    profileTypes,
    propertyHints,
    temporal: TEMPORAL_RE.test(q),
    confidence: Math.min(1, topScore / CONFIDENCE_SCALE),
    cleanedQuery,
  };
}

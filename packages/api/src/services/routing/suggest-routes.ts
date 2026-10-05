/**
 * Route suggestions — the router's SUGGEST half (intake plan §3.5 / W6, B15).
 *
 * Founder decision: routing is suggest-and-confirm with VISIBLE reasoning
 * (Linear triage shape), inline, never auto-run. So this module only RANKS and
 * EXPLAINS; nothing here runs a playbook or triggers an automation.
 *
 * PURE: candidates are loaded through the access layer and handed in —
 * playbooks by `playbooks.matchForEntity` (which also calls
 * `rankRouteCandidates`), propose-mode rules by `match-rules-for-entity.ts` —
 * and the capture followUp combines both lists per entity with
 * `suggestRoutesForEntities`, so the ranking rule exists once.
 *
 * SIGNALS ARE LEXICAL + STRUCTURAL ONLY. Embeddings have no fallback provider
 * (a pod without one would rank differently from a pod with one, silently), so
 * the rank depends on nothing that can be unavailable:
 *   - intent  — words of the user's intent text found in the candidate's name /
 *               description / goal (strongest: it is what the user SAID)
 *   - kind    — the candidate is built for the entity's own kind
 *   - facet   — the candidate is built for a role the entity plays
 *   - anyKind — the candidate has no kind filter (fires for everything new)
 *
 * ── RARITY (founder decision 2026-09-28, space-brief plan item 8) ───────────
 * An intent term is weighted by how RARE it is in THIS candidate pool, using
 * the pod's ONE IDF formula (`rarityWeight`, `utils/term-match.ts`). Measured
 * defect it fixes: the intent "design and build a feature … fix MCP discovery
 * gaps" ranked "CRM Hygiene" first on the words "agent" and "each" — "each"
 * sits in 7 of the 20 live candidates — and the flat 3-points-per-word sum tied it with
 * "AI Dev Session" (which alone says "build"), the tie then going to whichever
 * was edited last. A word most candidates share is weak evidence; a word only
 * one candidate has is strong evidence. The pool is whatever the caller
 * passes, so pass it AFTER every gate (rows a caller cannot see must never
 * move the ranking — same rule as `rankByTerms`).
 *
 * WHY NOT `rankByTerms` ITSELF: it caps a query at `MAX_QUERY_TERMS` (8 — a
 * bound for its SQL twin) and matches substrings, so a session goal would
 * lose every word after the eighth and "fix" would hit "prefix". The ranker
 * here keeps its whole-word stems and reuses only the rarity formula, so
 * there is still ONE IDF rule in the pod.
 *
 * ── WHAT IS RETURNED ────────────────────────────────────────────────────────
 * A candidate is returned only when it carries a signal ABOUT THIS REQUEST:
 * an intent word, the entity's kind, or one of its roles. `anyKind` is a
 * modifier, not evidence — "runs for anything new" is true of every
 * subject-less candidate for every request — so it is recorded (and scores)
 * only alongside an intent match, and a candidate with no real signal is not
 * returned at all. On the same live call, 9 of the 20 candidates returned
 * matched no word at all and rode back as "Runs for anything new" at 0.5.
 *
 * ── TIES ────────────────────────────────────────────────────────────────────
 * Broken by relevance, never by recency: more distinct intent words, then the
 * rarest word matched, then the structural signal (kind > facet), then the
 * name (a stable, edit-independent order). Editing a playbook must never
 * promote it.
 */

import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { rarityWeight } from "../../utils/term-match.js";

export type RouteCandidateKind = "playbook" | "automation";

export interface RouteCandidate {
  kind: RouteCandidateKind;
  id: string;
  name: string;
  /** Other searchable text: description, goal template… */
  text?: ReadonlyArray<string | null | undefined>;
  /** The kind the candidate is built for; `null` = fires for any kind. */
  subjectProfileSlug: string | null;
  /**
   * A RULE that PROPOSES (propose-mode `playbook_run`): confirming it files a
   * proposal, never a run. Only rules of this mode are suggested.
   */
  proposes?: true;
  /**
   * A PLAYBOOK built for a kind with no standing propose rule yet: a host may
   * offer "Always propose this", creating one through `skills.createRule`.
   */
  alwaysProposeOffer?: true;
}

export interface RouteEntity {
  entityId?: string;
  /** Omit when ranking a kind-less pool (intent-only match). */
  profileSlug?: string;
  /** Role-profile slugs the entity carries (facets). */
  facetSlugs?: readonly string[];
}

export type RouteSignal =
  | { type: "intent"; terms: string[] }
  | { type: "kind"; profileSlug: string }
  | { type: "facet"; profileSlug: string }
  | { type: "anyKind" };

export interface RankedRoute<C extends RouteCandidate = RouteCandidate> {
  candidate: C;
  score: number;
  /** One human-readable line: why this is suggested. */
  reason: string;
  signals: RouteSignal[];
}

const WEIGHT = { intentTerm: 3, kind: 2, facet: 1.5, anyKind: 0.5 } as const;

/** Words too common to be evidence of intent. */
const STOPWORDS: ReadonlySet<string> = new Set(
  "the and for with this that from into your you our are was were will have has had not but can all any its about when then than them they what which who how why also just more some such only very".split(
    " "
  )
);

/** Lowercase word → a loose stem (plural `s` dropped), so "reviews" ~ "review". */
function stem(word: string): string {
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss")
    ? word.slice(0, -1)
    : word;
}

/** Stem → the first original word it came from (for the human reason). */
export function tokenize(text: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of (text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (!out.has(s)) out.set(s, raw);
  }
  return out;
}

function nounFor(slug: string): string {
  return resolveObjectNoun(slug).toLowerCase();
}

function describe(signal: RouteSignal): string {
  switch (signal.type) {
    case "intent":
      return `You mentioned ${signal.terms.map((t) => `“${t}”`).join(", ")}`;
    case "kind":
      return `Made for ${nounFor(signal.profileSlug)} items`;
    case "facet":
      return `Matches its ${nounFor(signal.profileSlug)} role`;
    case "anyKind":
      return "Runs for anything new";
  }
}

/** Structural tie-break strength: kind beats facet beats none. */
function structuralRank(signals: readonly RouteSignal[]): number {
  if (signals.some((s) => s.type === "kind")) return 2;
  if (signals.some((s) => s.type === "facet")) return 1;
  return 0;
}

/**
 * Rank one entity's candidates, best first. Candidates with no signal about
 * this request are DROPPED (see the header: a suggestion must be able to say
 * why, and "runs for anything new" alone does not).
 */
export function rankRouteCandidates<C extends RouteCandidate>(input: {
  entity: RouteEntity;
  intentText?: string | null;
  candidates: readonly C[];
}): RankedRoute<C>[] {
  const intent = tokenize(input.intentText);
  const facets = new Set(input.entity.facetSlugs ?? []);

  // Each candidate's own words, once — the rarity pass and the scoring pass
  // both read them.
  const own =
    intent.size > 0
      ? input.candidates.map((c) =>
          tokenize([c.name, ...(c.text ?? [])].join(" "))
        )
      : [];
  // Rarity of each intent stem over THIS pool (the ONE IDF formula).
  const weightOf = new Map<string, number>();
  for (const stemmed of intent.keys()) {
    const docFreq = own.filter((words) => words.has(stemmed)).length;
    weightOf.set(stemmed, rarityWeight(input.candidates.length, docFreq));
  }

  const ranked = input.candidates.map((candidate, index) => {
    const signals: RouteSignal[] = [];
    let score = 0;
    let termCount = 0;
    let rarest = 0;

    if (intent.size > 0) {
      const hits = [...intent.entries()].filter(([s]) => own[index]!.has(s));
      if (hits.length > 0) {
        signals.push({ type: "intent", terms: hits.map(([, word]) => word) });
        termCount = hits.length;
        for (const [s] of hits) {
          const w = weightOf.get(s) ?? 0;
          score += WEIGHT.intentTerm * w;
          rarest = Math.max(rarest, w);
        }
      }
    }

    const slug = candidate.subjectProfileSlug;
    if (slug === null) {
      // A modifier, never evidence on its own (header, WHAT IS RETURNED).
      if (termCount > 0) {
        signals.push({ type: "anyKind" });
        score += WEIGHT.anyKind;
      }
    } else if (
      input.entity.profileSlug !== undefined &&
      slug === input.entity.profileSlug
    ) {
      signals.push({ type: "kind", profileSlug: slug });
      score += WEIGHT.kind;
    } else if (facets.has(slug)) {
      signals.push({ type: "facet", profileSlug: slug });
      score += WEIGHT.facet;
    }

    return {
      termCount,
      rarest,
      structural: structuralRank(signals),
      route: {
        candidate,
        score,
        reason: signals.map(describe).join(" · "),
        signals,
      },
    };
  });

  return ranked
    .filter((r) => r.route.signals.length > 0)
    .sort(
      (a, b) =>
        b.route.score - a.route.score ||
        b.termCount - a.termCount ||
        b.rarest - a.rarest ||
        b.structural - a.structural ||
        a.route.candidate.name.localeCompare(b.route.candidate.name) ||
        a.route.candidate.id.localeCompare(b.route.candidate.id)
    )
    .map((r) => r.route);
}

export interface EntityRouteSuggestions {
  entityId?: string;
  profileSlug: string;
  suggestions: RankedRoute[];
}

/**
 * The capture followUp's call: for each captured entity, merge its playbook AND
 * automation candidates (loaded through the two matcher doors) into ONE ranked
 * list with reasons. The ranker already drops candidates with no signal about
 * this request — a suggestion must be able to say why.
 */
export function suggestRoutesForEntities(input: {
  entities: ReadonlyArray<
    RouteEntity & {
      /** Capture follow-up always has a kind; omit those rows, don't invent "". */
      profileSlug: string;
      candidates: readonly RouteCandidate[];
    }
  >;
  intentText?: string | null;
  /** Per entity. Default 3 — an inline suggestion, not a catalogue. */
  limit?: number;
}): EntityRouteSuggestions[] {
  const limit = input.limit ?? 3;
  return input.entities.map((entity) => ({
    ...(entity.entityId ? { entityId: entity.entityId } : {}),
    profileSlug: entity.profileSlug,
    suggestions: rankRouteCandidates({
      entity,
      intentText: input.intentText,
      candidates: entity.candidates,
    }).slice(0, limit),
  }));
}

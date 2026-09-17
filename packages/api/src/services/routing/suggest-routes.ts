/**
 * Route suggestions — the router's SUGGEST half (intake plan §3.5 / W6, B15).
 *
 * Founder decision: routing is suggest-and-confirm with VISIBLE reasoning
 * (Linear triage shape), inline, never auto-run. So this module only RANKS and
 * EXPLAINS; nothing here runs a playbook or triggers an automation.
 *
 * PURE: candidates are loaded by the canonical matcher doors
 * (`playbooks.matchForEntity`, `automations.matchForEntity`) — which apply the
 * access layer — and handed in. Both doors call `rankRouteCandidates`, and the
 * capture followUp combines both lists per entity with
 * `suggestRoutesForEntities`, so the ranking rule exists once.
 *
 * SIGNALS ARE LEXICAL + STRUCTURAL ONLY. Embeddings have no fallback provider
 * (a pod without one would rank differently from a pod with one, silently), so
 * the rank depends on nothing that can be unavailable:
 *   - intent  — words of the user's intent text found in the candidate's name /
 *               description / goal (strongest: it is what the user SAID)
 *   - kind    — the candidate is built for the entity's own kind
 *   - facet   — the candidate is built for a role the entity plays
 *   - anyKind — an automation with no kind filter (fires for everything new)
 * Ties keep the matcher's order (most recently updated first).
 */

import { resolveObjectNoun } from "@synap-core/types/vocabulary";

export type RouteCandidateKind = "playbook" | "automation";

export interface RouteCandidate {
  kind: RouteCandidateKind;
  id: string;
  name: string;
  /** Other searchable text: description, goal template… */
  text?: ReadonlyArray<string | null | undefined>;
  /** The kind the candidate is built for; `null` = fires for any kind. */
  subjectProfileSlug: string | null;
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

/** Rank one entity's candidates. Stable: equal scores keep input order. */
export function rankRouteCandidates<C extends RouteCandidate>(input: {
  entity: RouteEntity;
  intentText?: string | null;
  candidates: readonly C[];
}): RankedRoute<C>[] {
  const intent = tokenize(input.intentText);
  const facets = new Set(input.entity.facetSlugs ?? []);

  const ranked = input.candidates.map((candidate, index) => {
    const signals: RouteSignal[] = [];
    let score = 0;

    if (intent.size > 0) {
      const own = tokenize(
        [candidate.name, ...(candidate.text ?? [])].join(" ")
      );
      const terms = [...intent.entries()]
        .filter(([s]) => own.has(s))
        .map(([, word]) => word);
      if (terms.length > 0) {
        signals.push({ type: "intent", terms });
        score += WEIGHT.intentTerm * terms.length;
      }
    }

    const slug = candidate.subjectProfileSlug;
    if (slug === null) {
      signals.push({ type: "anyKind" });
      score += WEIGHT.anyKind;
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
      index,
      route: {
        candidate,
        score,
        reason: signals.map(describe).join(" · "),
        signals,
      },
    };
  });

  return ranked
    .sort((a, b) => b.route.score - a.route.score || a.index - b.index)
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
 * list with reasons. Candidates with no signal at all are dropped — a
 * suggestion must be able to say why.
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
    })
      .filter((r) => r.signals.length > 0)
      .slice(0, limit),
  }));
}

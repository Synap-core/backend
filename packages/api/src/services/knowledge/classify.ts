/**
 * Substrate classification for the unified knowledge router (`ask`).
 *
 * Synap has four addressable memory kinds (see
 * team/platform/unified-knowledge-access.mdx): SEMANTIC (relevance recall over
 * the typed entity graph), STRUCTURED (an ENUMERATIVE typed listing — "what are
 * my tasks"), PROCEDURAL (knowledge_keys — institutional how-to docs), EPISODIC
 * (knowledge_facts — raw personal captures). The agent shouldn't pick a door;
 * `ask` routes for it. This pure classifier decides WHICH substrate(s) a query
 * touches, from cheap heuristics.
 *
 * SEMANTIC is the backbone and is ALWAYS queried (the entity graph answers most
 * "what do I know about X"). STRUCTURED / procedural / episodic are ADDED only
 * when their cues fire — so the common case stays a single SRE call, and we
 * never silently miss the enumerative list, the how-to-doc, or the raw capture
 * when the query clearly wants it.
 *
 * Matching is WORD-BOUNDARY, not raw substring: "deploy" must be the word
 * "deploy", not the tail of "redeployment"; "remember" won't fire on
 * "Remembrance Inc". And the cue lists deliberately avoid bare single-word nouns
 * that collide with this product's own entity vocabulary ("deploy", "setup",
 * "guide" are common entity names here) — a procedural intent is signalled by a
 * PHRASE ("how to …", "set up", "steps to") or a distinctive noun ("runbook"),
 * never by a lone verb that's just as likely an entity title. Over-routing only
 * adds a cheap extra query; mis-labelling `primary` actively misleads, so we bias
 * against false positives.
 */

import { KIND_CUES } from "../retrieval/understand-query.js";

export type SubstrateKind =
  | "semantic"
  | "structured"
  | "procedural"
  | "episodic";

/**
 * Enumerative LEAD phrases — a query is list-shaped when it opens with a
 * collection intent ("list my …", "what are my …", "which …"). Deliberately
 * COLLECTION-y: bare "what is X" (singular lookup) is NOT a lead, so it stays
 * semantic instead of triggering a typed listing.
 */
const ENUMERATIVE_CUES = [
  "list",
  "show",
  "how many",
  "who are",
  "what are",
  "which",
  "all my",
  "all the",
];

/**
 * Query-leading interrogatives that make a profile-naming query enumerative
 * even without a phrase cue — covers "what tasks are open right now" /
 * "what's on my plate", where "what" attaches directly to the noun instead of
 * forming "what are". Lead-anchored so mid-sentence "what" (e.g. "remember
 * what the task said") never triggers; the structured lane still additionally
 * requires a KIND_CUES profile match, so bare "what happened?" stays semantic.
 */
const ENUMERATIVE_LEAD_RE = /^\s*what(?:'s|s)?\b/;

/** Phrases / distinctive nouns that signal a how-to / runbook intent (knowledge_keys). */
const PROCEDURAL_CUES = [
  "how do",
  "how to",
  "how can",
  "how should",
  "how does",
  "how is",
  "how are",
  "runbook",
  "playbook",
  "walkthrough",
  "set up", // the phrasal verb; the noun "setup" is too entity-namey to cue on
  "steps to",
  "step by step",
  "procedure for",
  "documentation for",
  "docs for",
  "instructions for",
];

/** First-person recall phrasings that signal a raw-capture lookup (knowledge_facts). */
const EPISODIC_CUES = [
  "what did i",
  "what did we",
  "did i",
  "did we",
  "have i",
  "have we",
  "remember",
  "i noted",
  "i mentioned",
  "i said",
  "we said",
  "we discussed",
  "what i learned",
  "what was captured",
  "my notes about",
  "recall when",
];

/** Task-status words the structured lane understands (mapped to the enum downstream). */
const STATUS_CUES = ["open", "pending", "done", "completed"];

/** Compile each cue to a word-boundary regex once (cues are lowercase, no special chars). */
const compile = (cues: string[]): RegExp[] =>
  cues.map(
    (c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
  );

const ENUMERATIVE_RE = compile(ENUMERATIVE_CUES);
const PROCEDURAL_RE = compile(PROCEDURAL_CUES);
const EPISODIC_RE = compile(EPISODIC_CUES);
const STATUS_RE = compile(STATUS_CUES);

/**
 * Does the query name a profile that KIND_CUES recognizes (task/person/…)?
 * Plural-tolerant for single-word cues so "which deals" matches the `deal` cue
 * (mirrors understand-query's singular/plural handling).
 */
function cuesKind(q: string, tokenSet: Set<string>, cues: string[]): boolean {
  return cues.some((c) =>
    c.includes(" ")
      ? q.includes(c)
      : tokenSet.has(c) ||
        tokenSet.has(`${c}s`) ||
        tokenSet.has(c.replace(/s$/, ""))
  );
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface SubstrateRoute {
  /** Every substrate to query (semantic always present). */
  substrates: SubstrateKind[];
  /** The most-likely-relevant substrate — listed first in results. */
  primary: SubstrateKind;
  /**
   * When the STRUCTURED lane fired on the task profile AND the query named a
   * status ("open" / "done" …), the raw status word — mapped to the seeded enum
   * by `structuredLookup`. Undefined otherwise.
   */
  structuredStatus?: string;
}

export function classifySubstrates(query: string): SubstrateRoute {
  const q = ` ${query.toLowerCase()} `;
  const tokenSet = new Set(tokenize(query));

  const procedural = PROCEDURAL_RE.some((re) => re.test(q));
  const episodic = EPISODIC_RE.some((re) => re.test(q));

  // STRUCTURED: an enumerative lead AND a named profile — but suppressed when the
  // query is really a how-to (procedural) or a raw-capture recall (episodic), so
  // "what did I note about the project" stays episodic rather than listing every
  // project. Enumerative + typed = the user wants the whole set, not fuzzy top-k.
  const enumerative =
    (ENUMERATIVE_RE.some((re) => re.test(q)) || ENUMERATIVE_LEAD_RE.test(q)) &&
    Object.values(KIND_CUES).some((cues) => cuesKind(q, tokenSet, cues));
  const structured = enumerative && !procedural && !episodic;

  // Task-lane status filter — only meaningful when the enumerative query named
  // the task profile (so "list my open companies" carries no status).
  const structuredStatus =
    structured && cuesKind(q, tokenSet, KIND_CUES.task)
      ? STATUS_CUES.find((_, i) => STATUS_RE[i].test(q))
      : undefined;

  const substrates: SubstrateKind[] = ["semantic"];
  if (structured) substrates.push("structured");
  if (procedural) substrates.push("procedural");
  if (episodic) substrates.push("episodic");

  // A strongly-enumerative/procedural/episodic query is usually NOT best served
  // by relevance recall, so when cued, that substrate leads. Structured wins
  // (it's the most specific + actionable — the exact typed set); procedural then
  // beats episodic (how-to is the next most distinct intent).
  const primary: SubstrateKind = structured
    ? "structured"
    : procedural
      ? "procedural"
      : episodic
        ? "episodic"
        : "semantic";

  return {
    substrates,
    primary,
    ...(structuredStatus ? { structuredStatus } : {}),
  };
}

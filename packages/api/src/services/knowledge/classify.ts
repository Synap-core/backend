/**
 * Substrate classification for the unified knowledge router (`ask`).
 *
 * Synap has three genuinely-distinct memory kinds (see
 * team/platform/unified-knowledge-access.mdx): SEMANTIC (the typed entity graph),
 * PROCEDURAL (knowledge_keys — institutional how-to docs), EPISODIC
 * (knowledge_facts — raw personal captures). The agent shouldn't pick a door;
 * `ask` routes for it. This pure classifier decides WHICH substrate(s) a query
 * touches, from cheap heuristics.
 *
 * SEMANTIC is the backbone and is ALWAYS queried (the entity graph answers most
 * "what do I know about X"). Procedural / episodic are ADDED only when their cues
 * fire — so the common case stays a single SRE call, and we never silently miss
 * the how-to-doc or the raw capture when the query clearly wants it.
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

export type SubstrateKind = "semantic" | "procedural" | "episodic";

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

/** Compile each cue to a word-boundary regex once (cues are lowercase, no special chars). */
const compile = (cues: string[]): RegExp[] =>
  cues.map(
    (c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
  );

const PROCEDURAL_RE = compile(PROCEDURAL_CUES);
const EPISODIC_RE = compile(EPISODIC_CUES);

export interface SubstrateRoute {
  /** Every substrate to query (semantic always present). */
  substrates: SubstrateKind[];
  /** The most-likely-relevant substrate — listed first in results. */
  primary: SubstrateKind;
}

export function classifySubstrates(query: string): SubstrateRoute {
  const q = ` ${query.toLowerCase()} `;
  const procedural = PROCEDURAL_RE.some((re) => re.test(q));
  const episodic = EPISODIC_RE.some((re) => re.test(q));

  const substrates: SubstrateKind[] = ["semantic"];
  if (procedural) substrates.push("procedural");
  if (episodic) substrates.push("episodic");

  // A strongly-procedural/episodic query is usually NOT about typed entities,
  // so when cued, that substrate leads. Procedural wins ties (how-to is the most
  // distinct intent).
  const primary: SubstrateKind = procedural
    ? "procedural"
    : episodic
      ? "episodic"
      : "semantic";

  return { substrates, primary };
}

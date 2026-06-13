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
 */

export type SubstrateKind = "semantic" | "procedural" | "episodic";

/** "how do we deploy", "runbook", "setup guide" → procedural docs (knowledge_keys). */
const PROCEDURAL_CUES = [
  "how do ",
  "how to ",
  "how can ",
  "how should ",
  "how does ",
  "how is ",
  "guide",
  "runbook",
  "playbook",
  "set up",
  "setup",
  "deploy",
  "install",
  "configure",
  "procedure",
  "steps to",
  "step by step",
  "walkthrough",
  "tutorial",
  "documentation for",
  "docs for",
];

/** "what did I note about X", "remember when", "did we mention" → raw captures (knowledge_facts). */
const EPISODIC_CUES = [
  "what did i",
  "what did we",
  "did i ",
  "did we ",
  "have i ",
  "have we ",
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
  "last time",
  "earlier i",
];

export interface SubstrateRoute {
  /** Every substrate to query (semantic always present). */
  substrates: SubstrateKind[];
  /** The most-likely-relevant substrate — listed first in results. */
  primary: SubstrateKind;
}

export function classifySubstrates(query: string): SubstrateRoute {
  const q = ` ${query.toLowerCase()} `;
  const procedural = PROCEDURAL_CUES.some((c) => q.includes(c));
  const episodic = EPISODIC_CUES.some((c) => q.includes(c));

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

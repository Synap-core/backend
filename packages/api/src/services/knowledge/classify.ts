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

import {
  KIND_CUES,
  type ProfileCatalogEntry,
} from "../retrieval/understand-query.js";

export type SubstrateKind =
  "semantic" | "structured" | "procedural" | "episodic";

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
 * Query-leading interrogative that makes a profile-naming query enumerative
 * even without a phrase cue — covers "what tasks are open right now", where
 * "what" attaches directly to the noun instead of forming "what are".
 * Lead-anchored so mid-sentence "what" ("remember what the task said") never
 * triggers, and it only counts when a PLURAL profile noun appears — a set is
 * being requested. Singular lookups ("what is the Acme deal") stay semantic.
 */
const ENUMERATIVE_LEAD_RE = /^\s*what(?:'s|s)?\b/;

/** True when any KIND_CUES single-word cue appears in PLURAL form. */
function namesPluralKind(
  tokenSet: Set<string>,
  catalog?: ProfileCatalogEntry[]
): boolean {
  const pluralized = (cues: string[]) =>
    cues.some(
      (c) => !c.includes(" ") && !c.endsWith("s") && tokenSet.has(`${c}s`)
    );

  // The catalog arm must be applied HERE too, not only in the other enumerative
  // arm. This is the "what <kind> do we have" lead — and "what clients do we
  // have" is the exact phrasing that answered "you have no clients". Extending
  // one arm and not the other left the bug alive for half the phrasings.
  return (
    Object.values(KIND_CUES).some(pluralized) ||
    (catalog ? catalog.some((e) => pluralized(catalogWords(e))) : false)
  );
}

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

/**
 * Does the query name any profile the POD actually has?
 *
 * `KIND_CUES` is a hardcoded 9-key map of built-in kinds. It cannot know about
 * profiles a pod defines at runtime — and, critically, it contains NO role
 * profiles (client, partner, lead, sponsor …). Because role-profiles are how
 * Synap models relationships (`profileKind: 'role'`, attached as facets), a
 * pod could hold 20 clients and "list our clients" would still never reach the
 * structured lane: the enumerative gate below requires a NAMED kind, and no
 * role noun was nameable. The answer came back "you have no clients" while 20
 * client facets sat one indexed query away.
 *
 * The fix is to let the caller supply the pod's own catalog rather than to add
 * more literals here — `classifySubstrates` stays PURE and synchronous (it is
 * called on the parse-only fast path and must never touch a store); the caller
 * already loads this catalog for `understandQuery`, so nothing new is fetched.
 *
 * Matching mirrors `cuesKind`: whole tokens, with naive plural/singular
 * tolerance, plus the profile's own data-driven vocabulary (`plural`,
 * `synonyms`) so a pod that renames "Company" to "Account" works for free.
 */
function namesCatalogProfile(
  q: string,
  tokenSet: Set<string>,
  catalog: ProfileCatalogEntry[]
): boolean {
  return catalog.some((entry) => cuesKind(q, tokenSet, catalogWords(entry)));
}

/**
 * The vocabulary one catalog entry answers to, normalized for `cuesKind`.
 *
 * Normalize BEFORE filtering, not after: a slug of `"-"` or `"_"` is non-empty
 * as authored but normalizes to `""`, and an empty cue makes `tokenSet.has("s")`
 * true — so any query containing the token "s" would name that profile and drag
 * an unrelated 200-row enumeration to the front of the answer.
 */
function catalogWords(entry: ProfileCatalogEntry): string[] {
  return (
    [
      entry.slug,
      entry.displayName,
      entry.plural ?? undefined,
      ...(entry.synonyms ?? []),
    ]
      .filter((w): w is string => typeof w === "string")
      // A slug is kebab-case ("team-member"); tokenize() splits on non-alphanum,
      // so compare against the spaced form for multi-word terms.
      .map((w) => w.toLowerCase().replace(/[-_]+/g, " ").trim())
      .filter((w) => w.length > 0)
  );
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

export function classifySubstrates(
  query: string,
  /**
   * The pod's own profile catalog. Optional so the function stays usable (and
   * pure) without a store; when supplied it makes runtime-defined profiles —
   * above all ROLE profiles — nameable by the enumerative gate. See
   * `namesCatalogProfile`.
   */
  catalog?: ProfileCatalogEntry[]
): SubstrateRoute {
  const q = ` ${query.toLowerCase()} `;
  const tokenSet = new Set(tokenize(query));

  const procedural = PROCEDURAL_RE.some((re) => re.test(q));
  const episodic = EPISODIC_RE.some((re) => re.test(q));

  // STRUCTURED: an enumerative lead AND a named profile — but suppressed when the
  // query is really a how-to (procedural) or a raw-capture recall (episodic), so
  // "what did I note about the project" stays episodic rather than listing every
  // project. Enumerative + typed = the user wants the whole set, not fuzzy top-k.
  // A kind is "named" by the builtin cues OR by the pod's own catalog. The
  // catalog arm is what makes role profiles (client, partner, lead …) reachable
  // at all — without it the structured lane is limited to 9 hardcoded kinds.
  const namesKind =
    Object.values(KIND_CUES).some((cues) => cuesKind(q, tokenSet, cues)) ||
    (catalog ? namesCatalogProfile(q, tokenSet, catalog) : false);

  const enumerative =
    (ENUMERATIVE_RE.some((re) => re.test(q)) ||
      (ENUMERATIVE_LEAD_RE.test(q) && namesPluralKind(tokenSet, catalog))) &&
    namesKind;
  const structured = enumerative && !procedural && !episodic;

  // Task-lane status filter — only meaningful when the enumerative query named
  // the task profile (so "list my open companies" carries no status).
  const structuredStatus =
    structured && cuesKind(q, tokenSet, KIND_CUES.task)
      ? STATUS_CUES.find((_, i) => STATUS_RE[i].test(q))
      : undefined;

  // PROCEDURAL RUNS UNCONDITIONALLY — the cue only decides ORDER, not access.
  //
  // The cue list (`PROCEDURAL_CUES`) is a hand-written set of how-to phrasings.
  // Gating ACCESS on it meant a semantically-procedural question asked without
  // one of those exact words never touched `knowledge_keys` at all — the runbook
  // was there, ranked well, and simply never queried. Dogfooded: searching for
  // the contents of a captured runbook returned nothing, while the same question
  // prefixed with "how to" returned it as hit #1.
  //
  // Cheap to always run: one FTS query against a GIN index, and `semantic`
  // already runs unconditionally for the same reason. The cue keeps its real
  // job below — deciding which substrate LEADS.
  //
  // Episodic stays cue-gated: it is user-narrative recall ("what did I…"), and
  // firing it on every query changes what an untargeted question returns.
  const substrates: SubstrateKind[] = ["semantic", "procedural"];
  if (structured) substrates.push("structured");
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

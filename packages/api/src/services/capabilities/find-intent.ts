/**
 * `findByIntent` — the ONE discovery door: "what can do this?"
 *
 * An agent that knows what it wants to DO but not what the pod HAS has three
 * places to look, each with its own door, its own ranker and its own wire
 * shape: the capability catalog (`synap_list_capabilities`), the closed
 * abstract-intent axis (`list_capabilities({intent})`), and the pod's own
 * processes (`synap_match_playbooks` / the `playbooks` block `start_session`
 * ships). Three round trips, three vocabularies, and no single answer.
 *
 * This module is ASSEMBLY, not a fourth catalog. Every part below already
 * exists and is consumed unmodified:
 *   - `listCapabilities`      the ONE registry read (visibility floor included)
 *   - `projectRunnableActions` the ONE "what can actually be launched" rule
 *   - `runPosture`             (via the projection) the ONE auto|propose label
 *   - `rankByTerms`            the ONE lexical ranker (real IDF)
 *   - `foldVerbsByIntent`      the ONE intent reverse index
 *   - `matchSessionTemplate`   the ONE playbook matcher the start door uses
 *
 * ── FOUNDER DECISIONS ENCODED HERE ──────────────────────────────────────────
 *
 * **Match on the FULL QUERY.** Nothing here routes through `understandQuery`'s
 * `cleanedQuery`. That residue is the query with the NOUN stripped out, and the
 * noun ("clean up duplicate *contacts*") is the most discriminating token in an
 * intent. `understandQuery` is left untouched: its output is entity-type
 * shaped, and overloading it for capability routing is the exact drift this
 * codebase keeps paying for.
 *
 * **One `rankByTerms` call PER CATALOG, never one mixed call.** Rarity is
 * measured over the array you pass (`rarityWeight(N, df)`), so folding
 * capabilities and intents into one pool contaminates both IDF pools: a term
 * that is rare among 35 verbs looks common beside 13 abstract verbs. The
 * playbook arm does not even use the same ranker (`rankRouteCandidates` is a
 * token-count sum with no IDF at all), which is the sharpest form of the same
 * point.
 *
 * **Confidence is normalised PER CATALOG and the scale is NAMED on the wire.**
 * `understandQuery`'s `CONFIDENCE_SCALE = 4` is calibrated for profiles (a
 * direct hit 3 + a kind cue 2); there is no verb-side cue vocabulary, so a verb
 * reusing it would cap at 0.75 forever and sort below every well-cued profile.
 * Each catalog therefore emits its own `confidence` relative to its OWN best
 * row, and `scoring` says so in words — a caller must never compare a playbook
 * confidence to a capability one. The ABSOLUTE signal is `termCoverage`
 * (how many of the query's search terms this row actually hit), which is
 * comparable across catalogs because it is measured on the query, not the row.
 *
 * **ABSENT ≠ EMPTY, per catalog.** A block that is missing means that catalog
 * was NOT searched. A block whose `matches` is `[]` means it WAS searched and
 * nothing fit. Same distinction the `playbooks` block on `start_session`
 * already ships (and has door-parity tests for).
 *
 * **The RESULT is never bare emptiness.** Best published Recall@5 for lexical
 * intent routing is ~0.83, so one intent in five or six will miss — and an
 * agent handed `[]` improvises or stalls rather than abstaining. So a result
 * with no matches anywhere carries `noConfidentMatch`: the escalation ladder
 * (the real doors, from `skills/synap/from-intent.md` §2b) AND `coverage` —
 * how much was searched, and how much of the verb catalog even declares an
 * intent. That is the fix for the filed finding where
 * `list_capabilities({intent:"find_people"})` returned `[]` and the agent could
 * not tell "the pod cannot do this" from "the index is incomplete".
 *
 * **No index, no embedding, no LLM.** ~35 live verbs and a few hundred rows;
 * in-memory ranking is trivial. `listCapabilities` is a COLD read (6 SQL round
 * trips + one 60s-cached IS manifest fetch) and `matchSessionTemplate` adds a
 * 7th; that is the whole cost, measured, and it is not cached here. If it ever
 * gets hot, cache the ASSEMBLED catalog behind this module's own TTL — never
 * build a second index.
 */

import { ABSTRACT_VERBS, type AbstractVerb } from "@synap/database/schema";

import {
  rankByTerms,
  queryTerms,
  type TermMatch,
} from "../../utils/term-match.js";
import {
  listCapabilities,
  type CapabilityRegistryContext,
  type RegistryCapability,
} from "./capability-registry.js";
import {
  projectRunnableActions,
  type ProjectableCapability,
  type RunnableCapabilityAction,
} from "./action-projection.js";
import {
  foldVerbsByIntent,
  type IntentVerbMatch,
} from "./capability-intent-index.js";
import {
  matchSessionTemplate,
  type SessionPlaybookCandidates,
} from "../focus-sessions/match-session-template.js";

/** The three catalogs this door searches. A caller may narrow to some of them. */
export const FIND_CATALOGS = ["capabilities", "intents", "playbooks"] as const;
export type FindCatalog = (typeof FIND_CATALOGS)[number];

/** How many rows each catalog contributes at most. */
const CATALOG_LIMIT = 5;

export interface FindByIntentInput {
  /**
   * What the caller wants to DO, in their own words. Matched in FULL — never
   * reduced to a residue (see the module docblock).
   */
  intent: string;
  /** Workspace lens, or `null` for pod altitude. Never an authorization. */
  workspaceId: string | null;
  userId: string;
  agentUserId?: string;
  /**
   * Which catalogs to search. Default: all three. Typed loosely on purpose —
   * this is a wire value, so unknown names are DROPPED here rather than at an
   * adapter that would then own a second copy of the vocabulary. A list that
   * ends up empty falls back to all three: "the caller named only nonsense" is
   * not the same fact as "nothing matched", and answering it with an empty
   * result would report the second while meaning the first.
   */
  catalogs?: readonly unknown[];
  /** Per-catalog cap. Default {@link CATALOG_LIMIT}. */
  limit?: number;
}

/**
 * One runnable action that matched — the projection's own row, plus why it
 * matched and what it takes.
 */
export interface CapabilityIntentMatch {
  /** The launchable action, straight off `projectRunnableActions`. */
  action: RunnableCapabilityAction;
  /**
   * The verb's DECLARED arg schema (`ToolVerbCatalogEntry.argsSchema`) — carried
   * as DATA, not as a tool definition, so it works on every MCP client
   * regardless of `listChanged` support. Absent when the catalog entry declares
   * none (a skill-only action has no catalog entry at all: read
   * `action.parameters`, which is derived from the real contract).
   */
  argsSchema?: Record<string, unknown>;
  /** The capability's own description — when to reach for this. `null` when it has none. */
  whenToUse: string | null;
  /** Raw `rankByTerms` score over the runnable-action pool. */
  score: number;
  /** `score` ÷ the best score in THIS catalog. See `scoring`. */
  confidence: number;
  /** Which query terms hit, rarest first, and which fields. */
  match: TermMatch;
  /** How many of the query's search terms this row hit, out of how many. ABSOLUTE. */
  termCoverage: { hit: number; of: number };
}

/** One abstract intent the query's words landed on, with the verbs that declare it. */
export interface AbstractIntentMatch {
  intent: AbstractVerb;
  /** Verbs declaring it under this caller's lens. `[]` is a real answer. */
  verbs: IntentVerbMatch[];
  score: number;
  confidence: number;
  match: TermMatch;
  termCoverage: { hit: number; of: number };
}

/** What each catalog's numbers mean. Named on the wire so they are never compared. */
export interface FindScoring {
  capabilities?: ScaleNote;
  intents?: ScaleNote;
  playbooks?: ScaleNote;
}

export interface ScaleNote {
  ranker: string;
  scale: string;
  note: string;
}

/** How much was searched — the answer to "is the index incomplete, or is the pod?" */
export interface FindCoverage {
  /** Registry rows read under this lens. */
  capabilityRows: number;
  /** Of those, how many projected to a launchable action. */
  runnableActions: number;
  /** Verb catalog entries seen across those rows. */
  verbs: number;
  /**
   * How many of `verbs` declare an abstract `intent`. The intent axis can only
   * ever answer for these — the rest are invisible to an `intent` lookup, which
   * is why an empty intent result is not proof of absence.
   */
  verbsDeclaringIntent: number;
  /** Size of the closed abstract vocabulary. */
  abstractVerbs: number;
  /** Search terms the query reduced to (stopwords dropped, stemmed). */
  queryTerms: string[];
}

export interface NoConfidentMatch {
  reason: string;
  coverage: FindCoverage;
  /** The real doors, in order. Every rung exists — none is invented here. */
  escalation: Array<{ when: string; door: string }>;
}

export interface FindByIntentResult {
  intent: string;
  lens: { workspaceId: string | null };
  /** ABSENT when not searched; `matches: []` when searched and nothing fit. */
  capabilities?: { matches: CapabilityIntentMatch[] };
  intents?: { matches: AbstractIntentMatch[] };
  /** The EXACT block `start_session` ships. ABSENT when not searched. */
  playbooks?: SessionPlaybookCandidates;
  scoring: FindScoring;
  coverage: FindCoverage;
  /** Present only when no catalog produced a single match. */
  noConfidentMatch?: NoConfidentMatch;
}

/**
 * The escalation ladder from `skills/synap/from-intent.md` §2b, as data. Kept
 * here rather than in prose because an agent that reached this branch did NOT
 * find the skill — telling it to go read one is the dead end this replaces.
 */
const ESCALATION: NoConfidentMatch["escalation"] = [
  {
    when: "You suspect the verb exists but is worded differently",
    door: "synap_list_capabilities (no query) — scan the full catalog; matching here is lexical, not semantic",
  },
  {
    when: "The verb exists but is not enabled",
    door: "synap_run_capability — just run it; the refusal files ONE enable request and hands it back as `enableProposal`. There is no enable tool.",
  },
  {
    when: "The verb is not installed",
    door: 'synap_run_capability with verbId "market.search", then "market.install" — for an agent this files a capability.install proposal, which is success',
  },
  {
    when: "Synap has no such tool at all",
    door: 'synap_run_capability with verbId "tool.request" — records the gap instead of silently blocking you',
  },
];

function coverageOf(
  match: TermMatch,
  terms: string[]
): { hit: number; of: number } {
  return { hit: match.terms.length, of: terms.length };
}

/** `score` relative to the catalog's own best. 1 when it IS the best. */
function normalise(score: number, best: number): number {
  if (!(best > 0)) return 0;
  return Math.round((score / best) * 100) / 100;
}

/** Words for an abstract verb token, so "send a message" reaches `send_message`. */
function intentText(verb: AbstractVerb): string {
  return verb.replace(/_/g, " ");
}

export async function findByIntent(
  input: FindByIntentInput
): Promise<FindByIntentResult> {
  const named = (input.catalogs ?? []).filter((c): c is FindCatalog =>
    (FIND_CATALOGS as readonly unknown[]).includes(c)
  );
  const catalogs = new Set<FindCatalog>(
    named.length > 0 ? named : FIND_CATALOGS
  );
  const limit = input.limit ?? CATALOG_LIMIT;
  const terms = queryTerms(input.intent);

  const ctx: CapabilityRegistryContext = {
    workspaceId: input.workspaceId,
    userId: input.userId,
  };

  // ONE registry read serves BOTH the capability arm and the intent arm — the
  // intent index deliberately has no query of its own so that the visibility
  // floor is the registry's. Reading it twice would be two round trips for one
  // answer, not two answers.
  const needsRegistry = catalogs.has("capabilities") || catalogs.has("intents");
  // `limit: null` and no `query`: we rank the PROJECTION below, not the raw
  // rows, so slicing (or pre-ranking) here would decide the answer before the
  // candidate set exists.
  const rows: RegistryCapability[] = needsRegistry
    ? await listCapabilities(ctx, { limit: null })
    : [];

  const actions = needsRegistry
    ? projectRunnableActions(rows as ProjectableCapability[])
    : [];

  let verbs = 0;
  let verbsDeclaringIntent = 0;
  const argsSchemaByVerbId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    for (const verb of row.verbs ?? []) {
      verbs += 1;
      if (verb.intent) verbsDeclaringIntent += 1;
      // A lookup, not a second projection rule: the projection already decided
      // WHICH verbs are launchable; this only carries the declared schema back.
      if (verb.argsSchema && !argsSchemaByVerbId.has(verb.id)) {
        argsSchemaByVerbId.set(verb.id, verb.argsSchema);
      }
    }
  }

  const coverage: FindCoverage = {
    capabilityRows: rows.length,
    runnableActions: actions.length,
    verbs,
    verbsDeclaringIntent,
    abstractVerbs: ABSTRACT_VERBS.length,
    queryTerms: terms,
  };

  const scoring: FindScoring = {};
  const result: FindByIntentResult = {
    intent: input.intent,
    lens: { workspaceId: input.workspaceId },
    scoring,
    coverage,
  };

  // ── Catalog 1: runnable capability actions ────────────────────────────────
  if (catalogs.has("capabilities")) {
    const ranked = rankByTerms(
      input.intent,
      actions,
      (a) => ({
        primary: a.label,
        secondary: [a.verbId ?? "", a.tool ?? "", a.intent ?? ""].filter(
          Boolean
        ),
        tertiary: a.description ?? null,
      }),
      {
        primary: "label",
        secondary: "verbId/tool/intent",
        tertiary: "description",
      }
    );
    const best = ranked[0]?.score ?? 0;
    result.capabilities = {
      matches: ranked.slice(0, limit).map((r) => ({
        action: r.item,
        ...(r.item.verbId && argsSchemaByVerbId.has(r.item.verbId)
          ? { argsSchema: argsSchemaByVerbId.get(r.item.verbId)! }
          : {}),
        whenToUse: r.item.description ?? null,
        score: r.score,
        confidence: normalise(r.score, best),
        match: r.match,
        termCoverage: coverageOf(r.match, terms),
      })),
    };
    scoring.capabilities = {
      ranker:
        "rankByTerms (utils/term-match.ts) over the runnable-action projection",
      scale: "confidence = score ÷ the best capability score in THIS result",
      note: "Relative, not a probability: the top row is always 1. The absolute signal is termCoverage. Never compare this number to a playbook confidence — different ranker, different scale.",
    };
  }

  // ── Catalog 2: the closed abstract-intent axis ────────────────────────────
  if (catalogs.has("intents")) {
    const byIntent = foldVerbsByIntent(rows);
    // A SEPARATE rankByTerms call: 13 abstract verbs is its own rarity pool,
    // and folding it into the action pool above would skew both.
    const ranked = rankByTerms(
      input.intent,
      ABSTRACT_VERBS,
      (v) => ({ primary: [v, intentText(v)] }),
      { primary: "intent", secondary: "-", tertiary: "-" }
    );
    const best = ranked[0]?.score ?? 0;
    result.intents = {
      matches: ranked.slice(0, limit).map((r) => ({
        intent: r.item,
        verbs: byIntent.get(r.item) ?? [],
        score: r.score,
        confidence: normalise(r.score, best),
        match: r.match,
        termCoverage: coverageOf(r.match, terms),
      })),
    };
    scoring.intents = {
      ranker: "rankByTerms over the closed ABSTRACT_VERBS vocabulary",
      scale: "confidence = score ÷ the best intent score in THIS result",
      note: `Routing only — an intent resolves to CONCRETE verb ids that synap_run_capability then governs exactly as before. An intent with verbs: [] means nothing visible declares it; ${verbsDeclaringIntent} of ${verbs} verb catalog entries declare an intent at all, so this axis cannot see the rest.`,
    };
  }

  // ── Catalog 3: the pod's own processes ────────────────────────────────────
  if (catalogs.has("playbooks")) {
    // The SAME call `start_session` makes, returning the SAME wire block —
    // reused, never forked, so the two doors cannot disagree about what a
    // playbook candidate is.
    result.playbooks = await matchSessionTemplate({
      userId: input.userId,
      ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
      workspaceId: input.workspaceId,
      goal: input.intent,
    });
    scoring.playbooks = {
      ranker:
        "rankRouteCandidates (services/routing/suggest-routes.ts) — the ranker synap_start_session and capture suggestions use",
      scale: "raw score: a per-term weight summed, with NO rarity weighting",
      note: "A different ranker from the capability arms. Its scores are not comparable to theirs, and are passed through unchanged so this door and start_session report the same number.",
    };
  }

  const total =
    (result.capabilities?.matches.length ?? 0) +
    (result.intents?.matches.length ?? 0) +
    (result.playbooks?.candidates.length ?? 0);

  if (total === 0) {
    result.noConfidentMatch = {
      reason:
        `Nothing matched any word of ${JSON.stringify(input.intent)} in ${[...catalogs].join(", ")}. ` +
        `Matching is lexical (word stems, not meaning), so this is NOT proof the pod cannot do it — ` +
        `read \`coverage\` to see how much was searched before concluding anything is impossible.`,
      coverage,
      escalation: ESCALATION,
    };
  }

  return result;
}

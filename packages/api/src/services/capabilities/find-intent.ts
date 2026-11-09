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
 *   - `listSpaceCandidates`    the member spaces as rows (name, purpose via
 *                              `resolveSpacePurpose`, persona, collect + owned
 *                              kinds) — `services/discover/space-catalog.ts`
 *
 * The fourth catalog, `spaces`, answers "WHERE does this belong?" — an agent
 * asked to "store brand assets" must reach Brand Library and its `brand-*`
 * kinds, not a generic `file`. Same ranker, its own rarity pool, its own
 * confidence scale, and a failed read is `spaces.error`, never `matches: []`.
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
 * playbook arm does not even use the same ranker (`rankRouteCandidates` sums
 * per-term weights times the SAME `rarityWeight`, over its own playbook pool,
 * plus kind/facet bonuses), so its scores are on a different scale again.
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
 * already ships (and has door-parity tests for). `marketplace` is the same
 * fact: absent means the catalog cache was not read; `matches` (possibly
 * empty) means it was; `error` means the read threw — never rewritten as
 * `matches: []`.
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

import type { CatalogPlacement } from "../installations/request-installation.js";
import { listIntentRows, type IntentRow } from "./intent-registry.js";
import { intentText, rankIntentRows } from "./intent-ranking.js";

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
import type { SpaceCandidate } from "../discover/space-catalog.js";
import {
  OBJECT_CATALOGS,
  searchObjectCatalogs,
  type FindObjects,
  type ObjectCatalog,
} from "./find-objects.js";

/**
 * The catalogs this door searches. A caller may narrow to some of them. The
 * first four answer "what can DO this / where does it belong"; the object
 * catalogs (`find-objects.ts`) answer "what already says how — and where is
 * it": skills and rules, automations, sessions, goals, projects, views and
 * documents, each row carrying how to open it. `find-coverage.test.ts` holds
 * every kind `/open/<id>` can open to a catalog here or a reasoned exemption.
 */
export const FIND_CATALOGS = [
  "capabilities",
  "intents",
  "playbooks",
  "spaces",
  ...OBJECT_CATALOGS,
] as const;
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
   * Which catalogs to search. Default: all of them. Typed loosely on purpose —
   * this is a wire value, so unknown names are DROPPED here rather than at an
   * adapter that would then own a second copy of the vocabulary. A list that
   * ends up empty falls back to all of them: "the caller named only nonsense" is
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
  intent: string;
  /** Verbs declaring it under this caller's lens. `[]` is a real answer. */
  verbs: IntentVerbMatch[];
  score: number;
  confidence: number;
  match: TermMatch;
  termCoverage: { hit: number; of: number };
}

/**
 * One marketplace capability package a caller can install, with where it
 * runs (`catalogPlacementReader`, the same projection `market.search`
 * applies): for a capability that runs on a computer, its systems, licence
 * and the person's computers that can take it.
 */
export type MarketplaceCapabilityMatch = {
  slug: string;
  name: string;
  description: string | null;
  kind: string;
} & CatalogPlacement;

/**
 * Marketplace follow-up for an intent the pod does not serve.
 * `matches` and `error` are mutually exclusive: a thrown catalog read is
 * `error`, never a fake empty list.
 */
export type FindMarketplace =
  { matches: MarketplaceCapabilityMatch[] } | { error: string };

/** One member space the query's words landed on. */
export interface SpaceIntentMatch {
  workspaceId: string;
  name: string;
  /** `resolveSpacePurpose`, one line. Absent when the space declares none. */
  purpose?: string;
  /**
   * Up to 3 kinds to WRITE there: the ones the query's words named (ranked
   * over this space's own kinds), else the space's lead kinds (template
   * `collect` order first). Absent when the space declares no kinds.
   */
  kinds?: string[];
  score: number;
  confidence: number;
  match: TermMatch;
  termCoverage: { hit: number; of: number };
}

/**
 * The spaces block. `matches` and `error` are mutually exclusive: a failed
 * read is `error`, never a fake empty list.
 */
export type FindSpaces = { matches: SpaceIntentMatch[] } | { error: string };

/** What each catalog's numbers mean. Named on the wire so they are never compared. */
export type FindScoring = Partial<Record<FindCatalog, ScaleNote>>;

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

/**
 * Each object catalog's block (`skills`, `automations`, `sessions`, `goals`,
 * `projects`, `views`, `documents`): ABSENT when not searched, `matches`
 * (possibly empty) when searched, `error` when that read failed.
 */
export interface FindByIntentResult extends Partial<
  Record<ObjectCatalog, FindObjects>
> {
  intent: string;
  lens: { workspaceId: string | null };
  /** ABSENT when not searched; `matches: []` when searched and nothing fit. */
  capabilities?: { matches: CapabilityIntentMatch[] };
  intents?: { matches: AbstractIntentMatch[] };
  /** The EXACT block `start_session` ships. ABSENT when not searched. */
  playbooks?: SessionPlaybookCandidates;
  /**
   * Capability packages from the pod catalog cache that serve the best intent
   * (by their declared `provides` first, then by words). When a returned
   * intent has no installed verbs, or the best intent match is weak (it
   * missed a query term): any package. Otherwise only packages that run on
   * the person's computer (which of their computers can take one, and
   * `synap_list_installations` says which already have it). ABSENT when no
   * intent matched (the lookup did not run), or when a served intent has no
   * such computer tool.
   */
  marketplace?: FindMarketplace;
  /** Member spaces to route the work to. ABSENT when not searched. */
  spaces?: FindSpaces;
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

/** How many marketplace packages an unserved intent offers. */
const MARKETPLACE_LIMIT = 3;

/**
 * Which intent slug to ask the marketplace about, if any.
 *
 * An intent with `verbs: []` is a known kind of work nothing installed
 * serves. Otherwise the best row is weak when it missed a query term —
 * its confidence is always 1 when it ranked first, so that number cannot
 * say the routing was poor. `termCoverage` is the absolute signal. No row
 * at all is not a weak match: there is no slug to query, and the
 * escalation ladder already names `market.search`.
 */
function marketplaceSlugFor(
  matches: readonly AbstractIntentMatch[]
): { slug: string; computerOnly: boolean } | undefined {
  const unserved = matches.find((m) => m.verbs.length === 0);
  if (unserved) return { slug: unserved.intent, computerOnly: false };
  const best = matches[0];
  if (!best) return undefined;
  if (best.termCoverage.hit < best.termCoverage.of)
    return { slug: best.intent, computerOnly: false };
  // Served on the pod, and well matched: a tool that runs on the person's
  // COMPUTER for it is still worth naming (a pod verb that sends the video to
  // an outside service is not the same offer as ffmpeg on the Mac), so the
  // lookup runs and keeps only those.
  return { slug: best.intent, computerOnly: true };
}

/**
 * Does this catalog row serve the intent? FIRST by what it declares
 * (`provides`, the fact: media-transcribe provides `transcribe_media`), then,
 * for a row that declares nothing, by its words: catalog search is per word,
 * so "post" alone hits unrelated packages, and a row is kept only when its
 * slug, name, or description contains the raw slug or the full spaced phrase.
 * Fields are not joined. No survivor means `matches: []`, never the loose hits.
 */
function marketplaceEntryServesIntent(
  entry: { slug: string; name: string; description: string | null },
  slug: string,
  declared: ReadonlySet<string>
): boolean {
  if (declared.has(slug)) return true;
  const needles = [...new Set([slug, intentText(slug)])]
    .map((needle) => needle.toLowerCase())
    .filter((needle) => needle.length > 0);
  if (needles.length === 0) return false;
  return [entry.slug, entry.name, entry.description ?? ""].some((field) => {
    const haystack = field.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

/**
 * Catalog-cache read. A throw becomes `error` and does not fail the find —
 * the intent matches are already on the result.
 */
async function lookupMarketplace(
  slug: string,
  userId: string,
  opts: { computerOnly?: boolean } = {}
): Promise<FindMarketplace> {
  try {
    const { queryCatalogCache } = await import("./catalog-cache-query.js");
    const { catalogPlacementReader } =
      await import("../installations/request-installation.js");
    const { declaredProvides } =
      await import("./propose-intent-gap-install.js");
    const placementOf = catalogPlacementReader(userId);
    // EVERY capability row, kept by what it serves: a row that DECLARES the
    // intent but shares no word with it must not be cut by a top-3 word
    // ranking taken before the filter (media-transcribe says "transcript",
    // never "transcribe media"). The official catalog is a few dozen
    // capability rows; filtering them in memory is the whole cost.
    const entries = await queryCatalogCache({ kind: "capability" });
    const serving = entries
      .map((entry) => ({
        entry,
        // The ONE reader of a cached definition's `provides` (the gap
        // installer's); a definition that declares none is a word match only.
        declared: new Set(declaredProvides(entry) ?? []),
      }))
      .filter(({ entry, declared }) =>
        marketplaceEntryServesIntent(entry, slug, declared)
      )
      // A declared provider first: the fact outranks a word match.
      .sort(
        (a, b) => Number(b.declared.has(slug)) - Number(a.declared.has(slug))
      );
    const matches = await Promise.all(
      serving.map(async ({ entry }) => ({
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        kind: entry.kind,
        ...(await placementOf(entry)),
      }))
    );
    return {
      matches: (opts.computerOnly
        ? matches.filter((m) => m.runsOn?.includes("computer"))
        : matches
      ).slice(0, MARKETPLACE_LIMIT),
    };
  } catch (err) {
    return {
      error:
        err instanceof Error && err.message.length > 0
          ? err.message
          : String(err),
    };
  }
}

/** How many kinds a space match suggests. */
const SPACE_KIND_HINTS = 3;

/**
 * The kinds to suggest for one matched space: a SEPARATE `rankByTerms` call
 * over that space's own kinds (its own rarity pool — "brand" names every
 * Brand Library kind, "asset" only one), else its lead kinds.
 */
function spaceKindHints(query: string, kinds: readonly string[]): string[] {
  const hit = rankByTerms(query, kinds, (k) => ({
    primary: [k, k.replace(/[-_]+/g, " ")],
  }));
  return (hit.length ? hit.map((h) => h.item) : kinds).slice(
    0,
    SPACE_KIND_HINTS
  );
}

async function searchSpaces(
  query: string,
  userId: string,
  terms: string[],
  limit: number
): Promise<FindSpaces> {
  let candidates: SpaceCandidate[];
  try {
    const { listSpaceCandidates } =
      await import("../discover/space-catalog.js");
    candidates = await listSpaceCandidates(userId);
  } catch (err) {
    return {
      error:
        err instanceof Error && err.message.length > 0
          ? err.message
          : String(err),
    };
  }
  const ranked = rankByTerms(
    query,
    candidates,
    (c) => ({
      primary: c.name,
      secondary: c.kinds,
      tertiary: [c.purpose, c.persona].filter(Boolean).join(" "),
    }),
    { primary: "name", secondary: "kinds", tertiary: "purpose/persona" }
  );
  const best = ranked[0]?.score ?? 0;
  return {
    matches: ranked.slice(0, limit).map((r) => {
      const kinds = spaceKindHints(query, r.item.kinds);
      return {
        workspaceId: r.item.workspaceId,
        name: r.item.name,
        ...(r.item.purpose ? { purpose: r.item.purpose } : {}),
        ...(kinds.length ? { kinds } : {}),
        score: r.score,
        confidence: normalise(r.score, best),
        match: r.match,
        termCoverage: coverageOf(r.match, terms),
      };
    }),
  };
}

const OBJECT_SCALE =
  "confidence = score ÷ the best score in THIS catalog's block";
const OBJECT_NOTE =
  "Relative, not a probability; termCoverage is the absolute signal. Open a row with its `open` link (or diagnose/get by its id). Searched across everything you can read: the workspaceId lens is not a filter here. `error` means the read failed — not that nothing fits.";

/** What each object catalog's numbers mean (see `find-objects.ts`). */
const OBJECT_SCORING: Record<ObjectCatalog, ScaleNote> = {
  skills: {
    ranker:
      "searchInstructionSkills (services/skills/search.ts) reads the candidates — SQL rarity over every skill and rule you can see, the space's linked skills first — then rankByTerms over title/slug+topics+tags/description",
    scale: OBJECT_SCALE,
    note: `kind "skill" or "rule". Read one with synap_load_skill({ ref }). ${OBJECT_NOTE}`,
  },
  automations: {
    ranker:
      "rankByTerms over the best-matching non-archived automations you can see (name / description)",
    scale: OBJECT_SCALE,
    note: OBJECT_NOTE,
  },
  sessions: {
    ranker:
      "rankByTerms over the best-matching sessions you own (title / goal)",
    scale: OBJECT_SCALE,
    note: OBJECT_NOTE,
  },
  goals: {
    ranker:
      "rankByTerms over the best-matching goals of projects you can see (name / project name)",
    scale: OBJECT_SCALE,
    note: OBJECT_NOTE,
  },
  projects: {
    ranker:
      "rankByTerms over the best-matching projects you can see (name / description)",
    scale: OBJECT_SCALE,
    note: OBJECT_NOTE,
  },
  views: {
    ranker:
      "rankByTerms over the best-matching saved views you can see (name / view type / description)",
    scale: OBJECT_SCALE,
    note: OBJECT_NOTE,
  },
  documents: {
    ranker:
      "rankByTerms over the best-matching documents you can read, by TITLE only (bodies are synap_ask's)",
    scale: OBJECT_SCALE,
    note: OBJECT_NOTE,
  },
};

export async function findByIntent(
  input: FindByIntentInput
): Promise<FindByIntentResult> {
  const named = (input.catalogs ?? []).filter((c): c is FindCatalog =>
    (FIND_CATALOGS as readonly unknown[]).includes(c)
  );
  const catalogs = new Set<FindCatalog>(
    named.length > 0 ? named : FIND_CATALOGS
  );
  // A cap must be a positive whole number: `slice(0, -1)` / `slice(0, 2.5)`
  // would silently answer a different question than the caller asked.
  const limit =
    Number.isInteger(input.limit) && (input.limit as number) > 0
      ? (input.limit as number)
      : CATALOG_LIMIT;
  const terms = queryTerms(input.intent);

  // The object catalogs are independent reads: start them now, in parallel
  // with everything below, and collect them at the end. Each failure is that
  // catalog's own `{ error }` (searchObjectCatalogs never throws for one).
  const objectCatalogs = OBJECT_CATALOGS.filter((c) => catalogs.has(c));
  const objectsP = objectCatalogs.length
    ? searchObjectCatalogs({
        query: input.intent,
        userId: input.userId,
        workspaceId: input.workspaceId,
        catalogs: objectCatalogs,
        limit,
      })
    : Promise.resolve({});

  const vocabulary: IntentRow[] = catalogs.has("intents")
    ? await listIntentRows()
    : [];

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
    abstractVerbs: vocabulary.length,
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

  // ── Catalog 2: the intent registry (seed ∪ stored rows) ──────────────────
  if (catalogs.has("intents")) {
    const byIntent = foldVerbsByIntent(rows);
    // A SEPARATE rankByTerms call: the registry is its own rarity pool,
    // and folding it into the action pool above would skew both. The row's
    // own words rank it too: "remove my background" is `edit_video` only
    // through its synonym "remove background", never through its slug.
    const ranked = rankIntentRows(input.intent, vocabulary);
    const best = ranked[0]?.score ?? 0;
    result.intents = {
      matches: ranked.slice(0, limit).map((r) => ({
        intent: r.item.slug,
        verbs: byIntent.get(r.item.slug) ?? [],
        score: r.score,
        confidence: normalise(r.score, best),
        match: r.match,
        termCoverage: coverageOf(r.match, terms),
      })),
    };
    scoring.intents = {
      ranker:
        "rankByTerms over the intent registry (seed plus capability_intents rows): slug, then synonyms, then statement",
      scale: "confidence = score ÷ the best intent score in THIS result",
      note: `Routing only — an intent resolves to CONCRETE verb ids that synap_run_capability then governs exactly as before. An intent with verbs: [] means nothing visible declares it; ${verbsDeclaringIntent} of ${verbs} verb catalog entries declare an intent at all, so this axis cannot see the rest. When a returned intent has no verbs, or the best intent missed a query term, marketplace lists up to 3 capability packages that serve it; otherwise only those that run on the person's computer (synap_list_installations({capabilityKey}) says which computers have one). marketplace.error means that catalog read failed.`,
    };
    const pick = marketplaceSlugFor(result.intents.matches);
    if (pick) {
      const marketplace = await lookupMarketplace(pick.slug, input.userId, {
        computerOnly: pick.computerOnly,
      });
      // A served intent with no computer tool for it adds nothing to say:
      // no empty block on every well-served answer.
      const nothingExtra =
        pick.computerOnly &&
        "matches" in marketplace &&
        marketplace.matches.length === 0;
      if (!nothingExtra) result.marketplace = marketplace;
    }
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
      // The playbooks arm used to ignore `limit` (hard cap 5): ticket a9d88abf.
      limit,
    });
    scoring.playbooks = {
      ranker:
        "rankRouteCandidates (services/routing/suggest-routes.ts) — the ranker synap_start_session and capture suggestions use",
      scale:
        "raw score: per-term weight × rarityWeight over the playbook pool, summed, plus kind/facet bonuses",
      note: "A different ranker from the capability arms. Its scores are not comparable to theirs, and are passed through unchanged so this door and start_session report the same number.",
    };
  }

  // ── Catalog 4: the member spaces (WHERE the work belongs) ─────────────────
  if (catalogs.has("spaces")) {
    result.spaces = await searchSpaces(
      input.intent,
      input.userId,
      terms,
      limit
    );
    scoring.spaces = {
      ranker:
        "rankByTerms over the caller's member spaces (name / kinds / purpose+persona); kinds per space by a separate rankByTerms over that space's own kinds",
      scale: "confidence = score ÷ the best space score in THIS result",
      note: "Routing: pin the space (set_workspace_focus) to get its brief, then write one of its `kinds`. Every member space is searched regardless of the workspaceId lens. spaces.error means the read failed — not that no space fits.",
    };
  }

  // ── Catalogs 5+: the objects that say how, and where they are ─────────────
  const objects: Partial<Record<ObjectCatalog, FindObjects>> = await objectsP;
  for (const catalog of objectCatalogs) {
    const block = objects[catalog];
    if (!block) continue;
    result[catalog] = block;
    scoring[catalog] = OBJECT_SCORING[catalog];
  }
  const objectMatches = objectCatalogs.reduce((sum, c) => {
    const block = result[c];
    return sum + (block && "matches" in block ? block.matches.length : 0);
  }, 0);

  const total =
    objectMatches +
    (result.capabilities?.matches.length ?? 0) +
    (result.intents?.matches.length ?? 0) +
    (result.playbooks?.candidates.length ?? 0) +
    (result.spaces && "matches" in result.spaces
      ? result.spaces.matches.length
      : 0);

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

/**
 * `findByIntent` behind the caller's READ FLOOR — the ONE entry every door
 * uses (MCP `synap_find`, tRPC `knowledge.find`), so the lens rule cannot fork.
 *
 * A lens still has to be a space the caller reads. `listCapabilities`' own
 * contract says a non-null workspaceId is "a LENS, not an authorization"
 * (`capability-registry.ts`), and its tools predicate is
 * `isNull(workspaceId) OR eq(workspaceId, …)` with NO membership check; the
 * skills door reads the lens as a visibility tier. So the floor is checked
 * here, before anything is read: passing a workspace id you cannot read is
 * `forbidden`, never an enumeration of that space's tools.
 */
export type FindForCallerResult =
  { ok: true; result: FindByIntentResult } | { ok: false; forbidden: string };

export async function findForCaller(
  input: FindByIntentInput
): Promise<FindForCallerResult> {
  if (input.workspaceId) {
    const { canRead, userPrincipal } = await import("../../access/door.js");
    if (
      !(await canRead(userPrincipal(input.userId), {
        workspace: input.workspaceId,
      }))
    ) {
      return { ok: false, forbidden: input.workspaceId };
    }
  }
  return { ok: true, result: await findByIntent(input) };
}

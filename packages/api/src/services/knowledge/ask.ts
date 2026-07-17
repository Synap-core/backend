/**
 * `ask` — the unified knowledge router (one read door).
 *
 * Classifies the query's substrate intent, then queries the right store(s) in
 * parallel and returns ONE provenance-tagged answer: SEMANTIC via the Synap
 * Retrieval Engine (entities), PROCEDURAL via knowledge_keys (how-to docs),
 * EPISODIC via knowledge_facts (raw captures). Semantic always runs (the
 * backbone); the others only when cued, so the common case is a single SRE call.
 *
 * Glass-box, like the SRE: the result says WHICH substrates were queried, which
 * is primary, which DEGRADED (errored vs genuinely-empty — we never present a
 * store outage as "found nothing"), and carries the SRE's understanding + CRAG
 * verdict — so a caller (and the agent) can see the routing, never a black box.
 *
 * Scoping note (glass-box honesty): the three stores scope differently and that
 * is by design — semantic + episodic are userId-scoped; procedural (knowledge_keys
 * has no user-owner column) is addressed in the user's namespace via the
 * workspaceId slot, exactly as the sibling `GET /knowledge/search` does. A pinned
 * workspace narrows the semantic lens; a null lens means pod-wide for the user.
 *
 * See team/platform/unified-knowledge-access.mdx.
 */
import { knowledgeRepository, knowledgeKeysRepository } from "@synap/database";
import {
  retrieve,
  type RetrieveResult,
  type RankComparison,
} from "../retrieval/retrieve.js";
import {
  understandQuery,
  type ProfileCatalogEntry,
  type QueryUnderstanding,
} from "../retrieval/understand-query.js";
import type { RetrievalVerdict } from "../retrieval/grade.js";
import { classifySubstrates, type SubstrateKind } from "./classify.js";
import { structuredLookup } from "./structured.js";

/**
 * A degradation tag on the response. Substrate outages use the substrate name;
 * the semantic backbone additionally reports `"semantic:vector-down"` when its
 * vector leg was EXPECTED but ran keyword-only (the embedding provider failed) —
 * a partial degradation distinct from a whole-substrate error.
 */
export type DegradedTag = SubstrateKind | "semantic:vector-down";

export interface AskParams {
  query: string;
  userId: string;
  workspaceId?: string | null;
  /**
   * Project focus lens (a `project` entity id). When set, the semantic
   * substrate narrows to that project (project + everything that belongs_to it).
   * Orthogonal to workspaceId, pure-narrowing. Forwarded to the retrieval engine.
   */
  projectId?: string | null;
  /** Profile catalog for the semantic engine's type inference. */
  catalog: ProfileCatalogEntry[];
  limit?: number;
  /**
   * A/B diagnostic — forward to the semantic engine to run BOTH rankers on the
   * same pool and return the comparison. READ-ONLY: does not change the normal
   * answer. Defaults false.
   */
  compare?: boolean;
  /**
   * PARSE-ONLY fast path: return just the query understanding + glass-box routing
   * WITHOUT running any retrieval (no store queries). For a caller that needs to
   * turn "show all people" into a routed type BEFORE (or instead of) fetching
   * results — e.g. a command palette completing/highlighting the type word.
   * `answers` comes back empty and `verdict` is `"empty"` (nothing was
   * retrieved). Additive — existing callers are unaffected. Defaults false.
   */
  parseOnly?: boolean;
}

export interface AskAnswer {
  substrate: SubstrateKind;
  items: Record<string, unknown>[];
  /** `ok` = the store answered (possibly with 0 items); `error` = it failed and items is NOT authoritative. */
  status: "ok" | "error";
}

export interface AskResult {
  query: string;
  /** Substrates queried (semantic always present). */
  routedTo: SubstrateKind[];
  /** What the query's cues SUGGESTED (e.g. a "how to" → procedural). Glass-box intent. */
  intent: SubstrateKind;
  /**
   * The substrate that ACTUALLY answered — its block is listed first. Honest:
   * never points at a substrate that returned nothing. If the cued `intent`
   * substrate came back empty (e.g. "how to deploy" but the runbook lives as an
   * entity, not a procedural doc), `primary` falls back to whatever did answer.
   */
  primary: SubstrateKind;
  /** One answer block per queried substrate, primary first. */
  answers: AskAnswer[];
  /**
   * Degradation tags: substrates that ERRORED (their block carries
   * status:"error"; items unreliable), plus `"semantic:vector-down"` when the
   * semantic leg ran keyword-only because the embedding provider was down.
   */
  degraded: DegradedTag[];
  /** The semantic engine's query understanding (glass-box). */
  understanding: QueryUnderstanding;
  /** The semantic engine's CRAG verdict. */
  verdict: RetrievalVerdict;
  /** A/B ranker comparison — present only when `compare` was requested. */
  comparison?: RankComparison;
}

type Settled = { status: "ok" | "error"; items: Record<string, unknown>[] };

/** Fallback understanding when the retrieval engine itself fails. */
const FALLBACK_UNDERSTANDING: QueryUnderstanding = {
  profileTypes: [],
  propertyHints: [],
  temporal: false,
  confidence: 0,
};

/**
 * Run an ancillary store and report whether it ACTUALLY answered. We degrade an
 * outage to an empty result (the answer must survive a how-to-doc store being
 * down) but NEVER conflate "errored" with "found nothing" — that would be a
 * confident lie. The status rides along so the caller can tell them apart.
 */
async function settle(p: Promise<unknown[]>): Promise<Settled> {
  try {
    const items = (await p) as Record<string, unknown>[];
    return { status: "ok", items };
  } catch {
    return { status: "error", items: [] };
  }
}

export async function ask(params: AskParams): Promise<AskResult> {
  const { query, userId, workspaceId, projectId, catalog, compare, parseOnly } =
    params;
  const limit = params.limit ?? 10;
  const {
    substrates,
    primary: intent,
    structuredStatus,
  } = classifySubstrates(query);

  // PARSE-ONLY: understanding + glass-box routing, NO retrieval. understandQuery
  // is pure + deterministic — the same call retrieve() makes internally — so
  // lifting it here gives a caller the full routing without touching any store.
  if (parseOnly) {
    return {
      query,
      routedTo: substrates,
      intent,
      // No retrieval ran, so the effective primary is the cued intent — there is
      // no "which substrate actually answered" to fall back to.
      primary: intent,
      answers: [],
      degraded: [],
      understanding: understandQuery(query, catalog),
      verdict: "empty",
    };
  }

  // Semantic always runs (the backbone). Procedural / episodic run only when
  // cued and each reports its own ok/error status. projectId narrows the
  // semantic substrate to the active project focus.
  const semanticP = retrieve({
    query,
    userId,
    workspaceId,
    projectId,
    catalog,
    limit,
    compare,
  });
  // knowledge_keys has no user column; scope to the user's namespace (workspaceId
  // slot), matching GET /knowledge/search — `undefined` would read UNFILTERED
  // across every user/workspace on the pod.
  const proceduralP = substrates.includes("procedural")
    ? settle(
        knowledgeKeysRepository.searchFullText(
          query,
          workspaceId ?? userId,
          limit
        )
      )
    : Promise.resolve(null);
  const episodicP = substrates.includes("episodic")
    ? settle(knowledgeRepository.searchFacts({ userId, query, limit }))
    : Promise.resolve(null);

  // Semantic is the backbone — a failure must surface cleanly (never HTTP 500).
  // We await it separately so the caller gets a degraded answer with status:error
  // instead of a crash. Procedural / episodic are already settle()-wrapped.
  let semantic: RetrieveResult;
  let semanticStatus: AskAnswer["status"] = "ok";
  try {
    semantic = await semanticP;
  } catch (err) {
    console.error("[ask] semantic retrieval failed:", err);
    semantic = {
      entities: [],
      understanding: FALLBACK_UNDERSTANDING,
      // The whole leg errored, so no vector leg ran — reporting "hybrid" would
      // falsely claim the vector half contributed. `degraded:["semantic"]` below
      // already flags the outage; vector-down is a subset of that, not added here.
      source: "typesense",
      vectorDown: false,
      verdict: "empty",
    };
    semanticStatus = "error";
  }

  // STRUCTURED substrate — an enumerative, typed listing dispatched through the
  // SAME scoped door entities.list uses. The catalog-resolved profile slug comes
  // from the semantic engine's own type inference (the top inferred profile), so
  // "list my tasks" targets the real `task` slug; no resolved type ⇒ honestly
  // empty (routed but nothing to enumerate).
  let structured: Settled | null = null;
  if (substrates.includes("structured")) {
    const slug = semantic.understanding.profileTypes?.[0];
    structured = slug
      ? await settle(
          structuredLookup({
            profileSlug: slug,
            userId,
            workspaceId,
            projectId,
            status: slug === "task" ? structuredStatus : undefined,
            limit,
          })
        )
      : { status: "ok", items: [] };
  }

  const [procedural, episodic] = await Promise.all([proceduralP, episodicP]);

  const answers: AskAnswer[] = [
    { substrate: "semantic", items: semantic.entities, status: semanticStatus },
  ];
  const degraded: DegradedTag[] = [];
  if (semanticStatus === "error") degraded.push("semantic");
  // Partial degradation: the semantic leg answered but its vector half was down
  // (embedding provider failed), so ranking ran keyword-only. Distinct from a
  // whole-substrate error — surfaced so a caller knows recall was weakened.
  if (semanticStatus === "ok" && semantic.vectorDown)
    degraded.push("semantic:vector-down");
  if (structured) {
    answers.push({
      substrate: "structured",
      items: structured.items,
      status: structured.status,
    });
    if (structured.status === "error") degraded.push("structured");
  }
  if (procedural) {
    answers.push({
      substrate: "procedural",
      items: procedural.items,
      status: procedural.status,
    });
    if (procedural.status === "error") degraded.push("procedural");
  }
  if (episodic) {
    answers.push({
      substrate: "episodic",
      items: episodic.items,
      status: episodic.status,
    });
    if (episodic.status === "error") degraded.push("episodic");
  }
  // EFFECTIVE primary = the substrate that actually answered (never one that
  // came back empty). Prefer the cued `intent`; if it's empty, fall back to
  // whatever did answer (procedural → episodic → semantic). Caught by dogfood:
  // "how to deploy" cues procedural, but the deploy runbook is an entity, so
  // procedural was empty and semantic held the answer — primary must say so.
  const answered = (s: SubstrateKind): boolean =>
    answers.some(
      (a) => a.substrate === s && a.status === "ok" && a.items.length > 0
    );
  const primary: SubstrateKind = answered(intent)
    ? intent
    : ((["structured", "procedural", "episodic", "semantic"] as const).find(
        answered
      ) ?? intent);

  // Surface the most-relevant substrate first. Total-order comparator
  // (primary → 0, others → 1); stable sort preserves the natural
  // semantic→procedural→episodic order among the rest.
  answers.sort(
    (a, b) =>
      (a.substrate === primary ? 0 : 1) - (b.substrate === primary ? 0 : 1)
  );

  return {
    query,
    routedTo: substrates,
    intent,
    primary,
    answers,
    degraded,
    understanding: semantic.understanding,
    verdict: semantic.verdict,
    ...(semantic.comparison ? { comparison: semantic.comparison } : {}),
  };
}

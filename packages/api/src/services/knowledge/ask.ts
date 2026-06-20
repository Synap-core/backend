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
import { retrieve } from "../retrieval/retrieve.js";
import type {
  ProfileCatalogEntry,
  QueryUnderstanding,
} from "../retrieval/understand-query.js";
import type { RetrievalVerdict } from "../retrieval/grade.js";
import { classifySubstrates, type SubstrateKind } from "./classify.js";

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
  /** Substrates that ERRORED (their block carries status:"error"; items unreliable). */
  degraded: SubstrateKind[];
  /** The semantic engine's query understanding (glass-box). */
  understanding: QueryUnderstanding;
  /** The semantic engine's CRAG verdict. */
  verdict: RetrievalVerdict;
}

type Settled = { status: "ok" | "error"; items: Record<string, unknown>[] };

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
  const { query, userId, workspaceId, projectId, catalog } = params;
  const limit = params.limit ?? 10;
  const { substrates, primary: intent } = classifySubstrates(query);

  // Semantic always runs (the backbone) and is NOT wrapped — a total retrieval
  // failure should surface as an error, not a silent empty answer. Procedural /
  // episodic run only when cued and each reports its own ok/error status.
  // projectId narrows the semantic substrate to the active project focus.
  const semanticP = retrieve({
    query,
    userId,
    workspaceId,
    projectId,
    catalog,
    limit,
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

  const [semantic, procedural, episodic] = await Promise.all([
    semanticP,
    proceduralP,
    episodicP,
  ]);

  const answers: AskAnswer[] = [
    { substrate: "semantic", items: semantic.entities, status: "ok" },
  ];
  const degraded: SubstrateKind[] = [];
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
    : ((["procedural", "episodic", "semantic"] as const).find(answered) ??
      intent);

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
  };
}

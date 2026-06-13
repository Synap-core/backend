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
 * is primary, and carries the SRE's understanding + CRAG verdict — so a caller
 * (and the agent) can see the routing, never a black box.
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
  /** Profile catalog for the semantic engine's type inference. */
  catalog: ProfileCatalogEntry[];
  limit?: number;
}

export interface AskAnswer {
  substrate: SubstrateKind;
  items: Record<string, unknown>[];
}

export interface AskResult {
  query: string;
  /** Substrates queried (semantic always present). */
  routedTo: SubstrateKind[];
  /** Most-likely-relevant substrate — its answer is listed first. */
  primary: SubstrateKind;
  /** One answer block per queried substrate, primary first. */
  answers: AskAnswer[];
  /** The semantic engine's query understanding (glass-box). */
  understanding: QueryUnderstanding;
  /** The semantic engine's CRAG verdict. */
  verdict: RetrievalVerdict;
}

export async function ask(params: AskParams): Promise<AskResult> {
  const { query, userId, workspaceId, catalog } = params;
  const limit = params.limit ?? 10;
  const { substrates, primary } = classifySubstrates(query);

  // Semantic always runs (the backbone). Procedural / episodic run only when
  // cued. Each ancillary store degrades to [] on failure — a missing how-to-doc
  // store must never sink the whole answer.
  const semanticP = retrieve({ query, userId, workspaceId, catalog, limit });
  const proceduralP = substrates.includes("procedural")
    ? knowledgeKeysRepository
        .searchFullText(query, workspaceId ?? undefined, limit)
        .catch(() => [])
    : Promise.resolve(null);
  const episodicP = substrates.includes("episodic")
    ? knowledgeRepository.searchFacts({ userId, query, limit }).catch(() => [])
    : Promise.resolve(null);

  const [semantic, procedural, episodic] = await Promise.all([
    semanticP,
    proceduralP,
    episodicP,
  ]);

  const answers: AskAnswer[] = [
    { substrate: "semantic", items: semantic.entities },
  ];
  if (procedural) {
    answers.push({
      substrate: "procedural",
      items: procedural as Record<string, unknown>[],
    });
  }
  if (episodic) {
    answers.push({
      substrate: "episodic",
      items: episodic as Record<string, unknown>[],
    });
  }
  // Surface the most-relevant substrate first.
  answers.sort((a, b) =>
    a.substrate === primary ? -1 : b.substrate === primary ? 1 : 0
  );

  return {
    query,
    routedTo: substrates,
    primary,
    answers,
    understanding: semantic.understanding,
    verdict: semantic.verdict,
  };
}

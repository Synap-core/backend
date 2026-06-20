/**
 * Synap Retrieval Engine — the orchestrator (all five signals + correction).
 *
 *   understand(query) → embed once
 *   → recall passes:  semantic (pgvector) + lexical (Typesense), unscoped AND
 *                     type-scoped per inferred profile (the STRUCTURED signal)
 *   → GRAPH signal:   PPR-lite over native relations from the top recall hits,
 *                     fused into the candidate pool (multi-hop reach)
 *   → composite re-rank (ONE sort): fused position + bounded property-hint boost
 *                     + bounded temporal recency boost (when the query is temporal)
 *   → CRAG grade:     verdict for glass-box; re-key an EMPTY result set once
 *
 * Embeddings are one signal among five over the graph we already own. Each boost
 * is bounded (a nudge, never a partition) so RRF stays the primary ranking.
 * See team/platform/retrieval-architecture.mdx.
 */

import {
  db,
  entities,
  relations,
  and,
  eq,
  inArray,
  isNull,
} from "@synap/database";
import {
  projectLensWhere,
  BELONGS_TO_PROJECT,
} from "../../utils/project-scope.js";
import { embedQuery, hybridRecall, rrf } from "./hybrid-recall.js";
import { graphExpand, type Seed } from "./graph-signal.js";
import { latestEventTimestamps } from "./temporal-signal.js";
import { compositeRerank } from "./composite-rerank.js";
import { gradeResults, rekey, type RetrievalVerdict } from "./grade.js";
import {
  understandQuery,
  type ProfileCatalogEntry,
  type QueryUnderstanding,
} from "./understand-query.js";

export interface RetrieveParams {
  query: string;
  userId: string;
  workspaceId?: string | null;
  /**
   * Project focus lens (entity id of a `project`). When set, results are
   * narrowed to that project (the project entity + everything `belongs_to` it).
   * PURE narrowing, ANDed onto the user floor — like the workspace lens, it can
   * only restrict, never widen. Orthogonal to workspaceId.
   */
  projectId?: string | null;
  limit?: number;
  /** The workspace's real profile catalog (drives type inference). */
  catalog: ProfileCatalogEntry[];
}

export interface RetrieveResult {
  entities: Record<string, unknown>[];
  /** Why these results — surfaced for glass-box debugging + eval. */
  understanding: QueryUnderstanding;
  source: "hybrid" | "typesense";
  /** CRAG verdict on the result set. */
  verdict: RetrievalVerdict;
}

const GRAPH_SEED_CAP = 10;

type EntityRow = typeof entities.$inferSelect;

async function fetchOrdered(
  ids: string[],
  userId: string,
  projectId?: string | null
): Promise<EntityRow[]> {
  if (ids.length === 0) return [];
  // Defense-in-depth: gate on the loaded row's userId even though every id
  // source upstream (recall + graph edges) is already user-scoped.
  // Project lens (when set) is ANDed on as a PURE narrowing predicate — it can
  // only drop rows outside the project, never reveal anything new.
  const rows = await db
    .select()
    .from(entities)
    .where(
      and(
        inArray(entities.id, ids),
        eq(entities.userId, userId),
        isNull(entities.deletedAt),
        ...(projectId ? [projectLensWhere(entities.id, projectId)] : [])
      )
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is EntityRow => r !== undefined);
}

/**
 * Resolve a project's entity-id set — the project entity itself plus every
 * entity linked to it via `belongs_to_project`. Returned as a Set so recall
 * passes can constrain in-query. The recall halves already gate by userId, so
 * this only resolves membership. Empty set ⇒ nothing belongs to the project.
 */
async function resolveProjectIds(projectId: string): Promise<Set<string>> {
  const memberRows = await db
    .select({ id: relations.sourceEntityId })
    .from(relations)
    .where(
      and(
        eq(relations.type, BELONGS_TO_PROJECT),
        eq(relations.targetEntityId, projectId)
      )
    );
  const ids = new Set<string>(
    memberRows.map((r) => r.id).filter((id): id is string => id !== null)
  );
  ids.add(projectId); // the project entity itself is part of its own lens
  return ids;
}

export async function retrieve(
  params: RetrieveParams
): Promise<RetrieveResult> {
  const { query, userId, workspaceId, projectId, catalog } = params;
  const limit = params.limit ?? 20;

  const understanding = understandQuery(query, catalog);
  const embedding = await embedQuery(query); // once; reused across fused passes

  // Project focus lens — resolve the project's entity-id set ONCE (the project
  // entity + its belongs_to_project members), then constrain every recall pass
  // to it AT QUERY TIME. Without this the recall budget fills with non-project
  // rows and the project's matches never enter the pool (the post-filter alone
  // starves focus mode on a populated pod). Computed once, reused across passes.
  const projectIds = projectId ? await resolveProjectIds(projectId) : undefined;

  // 1. Recall passes — semantic + lexical, unscoped baseline + type-scoped.
  const passes = await Promise.all([
    hybridRecall({ query, userId, workspaceId, projectIds, limit, embedding }),
    ...understanding.profileTypes.slice(0, 2).map((slug) =>
      hybridRecall({
        query,
        userId,
        workspaceId,
        profileSlug: slug,
        projectIds,
        limit,
        embedding,
      })
    ),
  ]);
  const usedVector = passes.some((p) => p.usedVector);
  const source: "hybrid" | "typesense" = usedVector ? "hybrid" : "typesense";
  const recallLists = passes.map((p) => p.ids);

  // 2. Graph signal — expand the top recall hits across the relation graph and
  //    fuse the connected entities into the candidate pool (multi-hop reach).
  const recallSeeds = rrf(recallLists, 60).slice(0, GRAPH_SEED_CAP);
  const seeds: Seed[] = recallSeeds.map((id, i) => ({
    id,
    weight: 1 / (i + 1),
  }));
  // hops:2 reaches deal→company→person (the motivating 2-hop query); damping
  // decays the 2-hop contribution to ≤0.125 so far neighbors stay quiet.
  const graphHits = await graphExpand(seeds, userId, {
    seedCap: GRAPH_SEED_CAP,
    hops: 2,
  });
  const graphList = graphHits.map((h) => h.id);

  // 3. Fuse recall + graph into a pool 2× the final limit (re-rank headroom).
  const fusedIds = rrf([...recallLists, graphList], 60, limit * 2);

  // 3b. CRAG correction: the grader is the SINGLE source of truth for "should we
  //     correct?". On an empty pool it returns correction "rekey" → re-query once
  //     with content keywords (strip question/stopwords) so a lexical re-query can
  //     hit where the full phrasing buried the signal.
  if (fusedIds.length === 0) {
    if (gradeResults(understanding, []).correction === "rekey") {
      const kw = rekey(query);
      if (kw && kw !== query.toLowerCase().trim()) {
        const r2 = await hybridRecall({
          query: kw,
          userId,
          workspaceId,
          limit,
        });
        if (r2.ids.length > 0) {
          const rows2 = await fetchOrdered(r2.ids, userId, projectId);
          return {
            entities: rows2.slice(0, limit) as Record<string, unknown>[],
            understanding,
            source: r2.usedVector ? "hybrid" : "typesense",
            verdict: gradeResults(
              understanding,
              rows2.map((r) => r.type)
            ).verdict,
          };
        }
      }
    }
    return { entities: [], understanding, source, verdict: "empty" };
  }

  const ordered = await fetchOrdered(fusedIds, userId, projectId);

  // 4. Composite re-rank — fused position primary; property + temporal boosts are
  //    bounded to a fraction of the position span (see composite-rerank.ts).
  const now = Date.now();
  const eventTs = understanding.temporal
    ? await latestEventTimestamps(
        ordered.map((r) => r.id),
        userId
      )
    : undefined;
  const reranked = compositeRerank(ordered, {
    propertyHints: understanding.propertyHints,
    temporal: understanding.temporal,
    now,
    eventTs,
  });

  const finalRows = reranked.slice(0, limit);
  const verdict = gradeResults(
    understanding,
    finalRows.map((r) => r.type)
  ).verdict;

  return {
    entities: finalRows as Record<string, unknown>[],
    understanding,
    source,
    verdict,
  };
}

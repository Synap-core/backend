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
  documents,
  documentVersions,
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
import { resolveRankStrategy } from "./rank-strategy.js";
import { viewCountsByEntity } from "./reinforcement-signal.js";
import { centralityByEntity } from "./centrality-signal.js";
import { horizonScore, type HorizonScored } from "./horizon-rerank.js";
import { gradeResults, rekey, type RetrievalVerdict } from "./grade.js";
import {
  understandQuery,
  type ProfileCatalogEntry,
  type QueryUnderstanding,
} from "./understand-query.js";
import { createLogger } from "@synap-core/core";

const logger: any = createLogger({ module: "retrieval" });

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
  /**
   * A/B diagnostic: run BOTH the `baseline` and `horizon` rankers on the SAME
   * fused pool and attach the comparison to the result. READ-ONLY — the normal
   * `entities` returned are STILL the active strategy's output; compare only
   * ADDS a `comparison` block. Defaults false.
   */
  compare?: boolean;
}

/** One ranked entry in an A/B comparison list (top-`limit`). */
export interface RankedItem {
  id: string;
  title: string;
  score: number;
  rank: number;
}

/** An entity that appears in BOTH top-`limit` lists at a different rank. */
export interface MovedItem {
  id: string;
  title: string;
  baselineRank: number;
  horizonRank: number;
}

/** The A/B comparison payload attached when `compare` is set. */
export interface RankComparison {
  baseline: RankedItem[];
  horizon: RankedItem[];
  diff: {
    /** How many ids are shared between the two top-`limit` lists. */
    overlapAtN: number;
    /** Shared ids whose rank differs between the two strategies. */
    moved: MovedItem[];
  };
}

export interface RetrieveResult {
  entities: Record<string, unknown>[];
  /** Why these results — surfaced for glass-box debugging + eval. */
  understanding: QueryUnderstanding;
  source: "hybrid" | "typesense";
  /** CRAG verdict on the result set. */
  verdict: RetrievalVerdict;
  /** A/B ranker comparison — present only when `compare` was requested. */
  comparison?: RankComparison;
}

const GRAPH_SEED_CAP = 10;

type EntityRow = typeof entities.$inferSelect & {
  /**
   * The linked document's body (current-version content, up to the storage
   * layer's preview cap). Attached ADDITIVELY in `fetchOrdered` — entities
   * with no `documentId` (or whose document has no version row yet) simply
   * don't get this field. Synthesis (`synthesize.ts`) is the consumer.
   */
  content?: string;
};

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

  // Attach the entity BODY. `entities` has no content column — the full body
  // lives on the linked `documents` row's CURRENT VERSION (`document_versions
  // .content`, a generous 64k-char preview — see uploadDocumentVersionSnapshot
  // in @synap/database). Batch-joined once per call, purely additive: every
  // existing field on the row is untouched, we only ADD `content`.
  const docIds = rows
    .map((r) => r.documentId)
    .filter((id): id is string => id !== null && id !== undefined);
  const contentByDocId = new Map<string, string>();
  if (docIds.length > 0) {
    const bodies = await db
      .select({ documentId: documents.id, content: documentVersions.content })
      .from(documents)
      .innerJoin(
        documentVersions,
        and(
          eq(documentVersions.documentId, documents.id),
          eq(documentVersions.version, documents.currentVersion)
        )
      )
      .where(inArray(documents.id, docIds));
    for (const b of bodies) {
      if (b.content) contentByDocId.set(b.documentId, b.content);
    }
  }

  const byId = new Map<string, EntityRow>(
    rows.map((r) => [
      r.id,
      r.documentId && contentByDocId.has(r.documentId)
        ? { ...r, content: contentByDocId.get(r.documentId) }
        : r,
    ])
  );
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

const titleOf = (r: EntityRow): string => r.title ?? "";

/**
 * Build the A/B comparison from the two rankings over the SAME pool. Baseline
 * scores are rank-normalized (the composite ranker exposes only an ordering, by
 * design); Horizon carries its real weighted score. Ranks are 1-based and
 * authoritative — `overlapAtN` + `moved` are computed from them.
 */
function buildComparison(
  baseRanked: EntityRow[],
  horizonScored: HorizonScored<EntityRow>[],
  limit: number
): RankComparison {
  const baseTop = baseRanked.slice(0, limit);
  const horizonTop = horizonScored.slice(0, limit);

  const baseline: RankedItem[] = baseTop.map((r, i) => ({
    id: r.id,
    title: titleOf(r),
    // Composite exposes order, not a score — represent it as normalized rank.
    score: Number(((baseTop.length - i) / baseTop.length).toFixed(4)),
    rank: i + 1,
  }));
  const horizon: RankedItem[] = horizonTop.map((x, i) => ({
    id: x.row.id,
    title: titleOf(x.row),
    score: Number(x.score.toFixed(4)),
    rank: i + 1,
  }));

  const horizonRankById = new Map(horizon.map((h) => [h.id, h.rank]));
  const baselineIds = new Set(baseline.map((b) => b.id));
  const overlapAtN = horizon.filter((h) => baselineIds.has(h.id)).length;
  const moved: MovedItem[] = baseline.flatMap((b) => {
    const hr = horizonRankById.get(b.id);
    return hr !== undefined && hr !== b.rank
      ? [
          {
            id: b.id,
            title: b.title,
            baselineRank: b.rank,
            horizonRank: hr,
          },
        ]
      : [];
  });

  return { baseline, horizon, diff: { overlapAtN, moved } };
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

  // 4. Rank — resolve the ACTIVE strategy (pod_settings JSONB; default 'baseline'
  //    so this changes nothing until a pod admin opts in) then rank + slice.
  //    `compare` runs BOTH strategies on the SAME pool for A/B; it only ADDS a
  //    `comparison` block — the returned entities stay the active strategy's.
  const now = Date.now();
  const strategy = await resolveRankStrategy();
  const compare = params.compare === true;

  // baseline = the EXISTING composite re-rank, byte-identical to pre-Horizon.
  const runBaseline = async (): Promise<EntityRow[]> => {
    const eventTs = understanding.temporal
      ? await latestEventTimestamps(
          ordered.map((r) => r.id),
          userId
        )
      : undefined;
    return compositeRerank(ordered, {
      propertyHints: understanding.propertyHints,
      temporal: understanding.temporal,
      now,
      eventTs,
    });
  };

  // horizon = the lens-weighted scorer (recency + reinforcement + centrality +
  // query relevance; L=0 this phase). Batches its signals over the pool ids.
  const runHorizon = async (): Promise<HorizonScored<EntityRow>[]> => {
    const ids = ordered.map((r) => r.id);
    // Each Horizon signal degrades independently: a failed fetch (e.g. the
    // `entity_centrality` table missing before the Phase-3 migration has run, or
    // any DB error) falls back to a degraded signal instead of rejecting the
    // whole rank, so Horizon still computes. (The signal modules already swallow
    // errors internally; these catches are belt-and-suspenders.)
    const [viewCounts, lastTouch, pageRank] = await Promise.all([
      viewCountsByEntity(ids, userId).catch((err) => {
        logger.warn(
          { err },
          "horizon reinforcement signal failed — degrading to empty"
        );
        return new Map<string, number>();
      }),
      latestEventTimestamps(ids, userId),
      centralityByEntity(ids, userId).catch((err) => {
        logger.warn(
          { err },
          "horizon centrality signal failed — degrading to graph proxy"
        );
        return new Map<string, number>();
      }),
    ]);
    // C = global PageRank from entity_centrality (Phase 3). Graceful fallback:
    // if the batch job hasn't populated any of the pool ids yet, drop back to the
    // graph-propagation-weight proxy (the pre-Phase-3 behavior) so Horizon still
    // ranks. horizonScore normalizes whichever map to [0,1] over the pool.
    const centrality =
      pageRank.size > 0
        ? pageRank
        : new Map(graphHits.map((h) => [h.id, h.score]));
    return horizonScore(ordered, {
      lens: projectId ? "project" : "workspace",
      now,
      viewCounts,
      lastTouch,
      centrality,
    });
  };

  // Whole-Horizon guard: recall must NEVER error because the Horizon ranker
  // threw. If runHorizon rejects for ANY reason we fall back to baseline (normal
  // path) or omit the horizon side (compare path) — baseline stays intact.
  const runHorizonSafe = async (): Promise<HorizonScored<EntityRow>[] | null> =>
    runHorizon().catch((err) => {
      logger.warn({ err }, "horizon ranker failed — falling back to baseline");
      return null;
    });

  let finalRows: EntityRow[];
  let comparison: RankComparison | undefined;
  if (compare) {
    const [baseRanked, horizonScored] = await Promise.all([
      runBaseline(),
      runHorizonSafe(),
    ]);
    // On Horizon failure the comparison's horizon side is empty; baseline intact.
    comparison = buildComparison(baseRanked, horizonScored ?? [], limit);
    // The active strategy still decides the NORMAL (non-compare) return; if
    // Horizon failed, the active output falls back to baseline.
    const active =
      strategy === "horizon" && horizonScored
        ? horizonScored.map((x) => x.row)
        : baseRanked;
    finalRows = active.slice(0, limit);
  } else if (strategy === "horizon") {
    const horizonScored = await runHorizonSafe();
    finalRows = (
      horizonScored ? horizonScored.map((x) => x.row) : await runBaseline()
    ).slice(0, limit);
  } else {
    finalRows = (await runBaseline()).slice(0, limit);
  }

  const verdict = gradeResults(
    understanding,
    finalRows.map((r) => r.type)
  ).verdict;

  return {
    entities: finalRows as Record<string, unknown>[],
    understanding,
    source,
    verdict,
    ...(comparison ? { comparison } : {}),
  };
}

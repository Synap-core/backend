/**
 * PageRank Centrality Worker (Horizon Wave 2, Phase 3).
 *
 * Computes a GLOBAL PageRank over each user's native `relations` graph and
 * UPSERTs the per-entity score into `entity_centrality`. Horizon reads that
 * score as its centrality signal `C` (see services/retrieval/centrality-signal.ts
 * + horizon-rerank.ts); this replaces the old graph-propagation-weight proxy.
 *
 * Scale / perf contract
 * ---------------------
 *   - The edge list is read ONCE PER USER in a single batched query (NOT per
 *     node). The pod has a known "/relations read at scale" concern, so we never
 *     do N+1 traversal — we pull the whole edge list and build an in-memory
 *     adjacency map. A single-user graph is a few thousand nodes, so in-memory
 *     PageRank is cheap.
 *   - Iterations are BOUNDED (≤ MAX_ITERATIONS) with an early-exit when the L1
 *     delta between iterations drops below EPSILON.
 *
 * Directionality
 * --------------
 *   We SYMMETRIZE the graph (every edge counts both ways) before running
 *   PageRank. Relation direction in Synap is largely an authoring artifact
 *   (A `belongs_to` B ⇄ B `has` A), so for a GLOBAL "importance" score a
 *   well-connected hub should rank high regardless of which way its edges were
 *   authored. Symmetrization also removes most dangling-node cases (an isolated
 *   node simply never appears in the edge list). Remaining dangling mass (a node
 *   with no out-neighbors, which after symmetrization means a node with no edges
 *   at all — impossible here — is handled defensively) is redistributed
 *   uniformly each iteration. If lens-scoped / directed PageRank is ever needed
 *   that is Phase 3b (personalized `L`), out of scope here.
 */

import {
  db,
  relations,
  entities,
  entityCentrality,
  and,
  eq,
  isNotNull,
  inArray,
  notInArray,
  drizzleSql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { Edge } from "../utils/pagerank.js";
import { rankGraph } from "../utils/cpu-pool.js";

// The pure math lives in utils/pagerank.ts (the CPU pool's worker runs it
// with no database); re-exported for its callers and tests.
export { buildAdjacency, pageRank } from "../utils/pagerank.js";

const logger = createLogger({ module: "pagerank-centrality" });

export const PAGERANK_CENTRALITY_QUEUE = "pagerank-centrality";

/**
 * Cron cadence — every 6 hours at :20 (off-peak minute, clear of the daily 03:xx
 * jobs and the top-of-hour syncs). TUNABLE: bump to hourly if the graph churns
 * fast, or to daily if compute cost matters more than freshness.
 */
export const PAGERANK_CENTRALITY_CRON = "20 */6 * * *";

/** Chunk size for the score UPSERT (well under Postgres' bind-param ceiling). */
const UPSERT_CHUNK = 1000;

/** One batched edge read for a single user — only entity↔entity relations. */
async function loadEdges(userId: string): Promise<Edge[]> {
  const rows = await db
    .select({
      src: relations.sourceEntityId,
      tgt: relations.targetEntityId,
    })
    .from(relations)
    .where(
      and(
        eq(relations.userId, userId),
        eq(relations.sourceKind, "entity"),
        eq(relations.targetKind, "entity"),
        isNotNull(relations.sourceEntityId),
        isNotNull(relations.targetEntityId)
      )
    );
  return rows
    .filter((r): r is { src: string; tgt: string } => !!r.src && !!r.tgt)
    .map((r) => ({ src: r.src, tgt: r.tgt }));
}

/**
 * Keep only node ids that still exist as this user's entities — the FK on
 * entity_centrality.entity_id would reject an orphaned relation endpoint.
 * PageRank is computed over the full edge graph; we only WRITE scores for live
 * entities.
 */
async function filterExistingEntities(
  userId: string,
  ids: string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.userId, userId), inArray(entities.id, ids)));
  return new Set(rows.map((r) => r.id));
}

/** UPSERT the per-entity scores for one user, then prune stale rows. */
async function persistScores(
  userId: string,
  scores: Array<{ entityId: string; score: number }>,
  computedAt: Date
): Promise<void> {
  const liveIds = scores.map((s) => s.entityId);

  if (scores.length === 0) {
    // No graph → drop every stored score for this user (fully recomputable).
    await db
      .delete(entityCentrality)
      .where(eq(entityCentrality.userId, userId));
    return;
  }

  for (let i = 0; i < scores.length; i += UPSERT_CHUNK) {
    const chunk = scores.slice(i, i + UPSERT_CHUNK).map((s) => ({
      entityId: s.entityId,
      userId,
      score: s.score,
      computedAt,
    }));
    await db
      .insert(entityCentrality)
      .values(chunk)
      .onConflictDoUpdate({
        target: entityCentrality.entityId,
        set: {
          score: drizzleSql.raw("excluded.score"),
          userId: drizzleSql.raw("excluded.user_id"),
          computedAt,
        },
      });
  }

  // Prune rows for entities that dropped out of the user's graph since last run.
  await db
    .delete(entityCentrality)
    .where(
      and(
        eq(entityCentrality.userId, userId),
        notInArray(entityCentrality.entityId, liveIds)
      )
    );
}

/**
 * Cron/on-demand handler. Recomputes global PageRank for EVERY user with a
 * relation graph and UPSERTs the scores. Registered as a 6-hourly cron and
 * enqueued once on startup (cron.ts) so a cold pod populates without waiting.
 */
export async function handlePageRankCentrality(): Promise<void> {
  const computedAt = new Date();

  // Distinct users that own any relation — one small query, then per-user work.
  const userRows = await db
    .selectDistinct({ userId: relations.userId })
    .from(relations);
  const userIds = userRows.map((r) => r.userId).filter((u): u is string => !!u);

  logger.info(
    { users: userIds.length },
    "pagerank-centrality: starting global centrality recompute"
  );

  let totalScored = 0;
  for (const userId of userIds) {
    try {
      const edges = await loadEdges(userId);
      // Off the event loop past a small graph (≈ 0.6 s of CPU at 10k nodes /
      // 50k edges, measured): under a deadline, a typed failure on timeout,
      // caught below like any other per-user failure (old scores kept).
      const ranks = await rankGraph(edges);

      const existing = await filterExistingEntities(
        userId,
        Array.from(ranks.keys())
      );
      const scores = Array.from(ranks.entries())
        .filter(([id]) => existing.has(id))
        .map(([entityId, score]) => ({ entityId, score }));

      await persistScores(userId, scores, computedAt);
      totalScored += scores.length;
    } catch (err) {
      // One user's failure must not abort the whole batch; log and continue.
      logger.error(
        { err, userId },
        "pagerank-centrality: failed for user, skipping"
      );
    }
  }

  logger.info(
    { users: userIds.length, entitiesScored: totalScored },
    "pagerank-centrality: recompute complete"
  );
}

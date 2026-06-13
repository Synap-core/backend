/**
 * Synap Retrieval Engine — Phase 1 orchestrator (the structured signal).
 *
 * understand() → embed once → fuse UNSCOPED recall with TYPE-SCOPED recall for
 * each inferred profile type. Entities of the inferred type land in both lists →
 * boosted by RRF; everything else still flows through the unscoped list → no
 * recall loss when the inference is wrong. A light property-hint re-rank gives a
 * BOUNDED lift to rows whose property VALUES match (e.g. role=VP) — it nudges,
 * never partitions, so it can't override RRF wholesale.
 *
 * This is the foundation later phases extend (graph PPR, temporal, CRAG).
 * See team/platform/retrieval-architecture.mdx.
 */

import { db, entities, and, inArray, isNull } from "@synap/database";
import { embedQuery, hybridRecall, rrf } from "./hybrid-recall.js";
import { matchesHint } from "./property-hint-match.js";
import {
  understandQuery,
  type ProfileCatalogEntry,
  type QueryUnderstanding,
} from "./understand-query.js";

export interface RetrieveParams {
  query: string;
  userId: string;
  workspaceId?: string | null;
  limit?: number;
  /** The workspace's real profile catalog (drives type inference). */
  catalog: ProfileCatalogEntry[];
}

export interface RetrieveResult {
  entities: Record<string, unknown>[];
  /** Why these results — surfaced for glass-box debugging + eval. */
  understanding: QueryUnderstanding;
  source: "hybrid" | "typesense";
}

export async function retrieve(
  params: RetrieveParams
): Promise<RetrieveResult> {
  const { query, userId, workspaceId, catalog } = params;
  const limit = params.limit ?? 20;

  const understanding = understandQuery(query, catalog);
  const embedding = await embedQuery(query); // once; reused across fused passes

  // baseline unscoped pass + one type-scoped pass per inferred type (max 2).
  // Each pass already widens its own candidate scan internally — pass `limit`,
  // not a pre-widened value, so the scan isn't compounded.
  const passes = await Promise.all([
    hybridRecall({ query, userId, workspaceId, limit, embedding }),
    ...understanding.profileTypes.slice(0, 2).map((slug) =>
      hybridRecall({
        query,
        userId,
        workspaceId,
        profileSlug: slug,
        limit,
        embedding,
      })
    ),
  ]);

  const usedVector = passes.some((p) => p.usedVector);
  const source: "hybrid" | "typesense" = usedVector ? "hybrid" : "typesense";

  // Fuse into a pool 2× the final limit to give the re-rank some headroom.
  const fusedIds = rrf(
    passes.map((p) => p.ids),
    60,
    limit * 2
  );
  if (fusedIds.length === 0) {
    return { entities: [], understanding, source };
  }

  // Fetch rows, preserve fused order.
  const rows = await db
    .select()
    .from(entities)
    .where(and(inArray(entities.id, fusedIds), isNull(entities.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let ordered = fusedIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  // Bounded property-hint re-rank: fused position is the primary signal; a hint
  // match adds a small, capped boost. A single hit lifts a near-miss a few
  // places but cannot drag a low-ranked row to the top.
  if (understanding.propertyHints.length > 0) {
    const HINT_BOOST = 3;
    const n = ordered.length;
    ordered = ordered
      .map((row, i) => {
        const props =
          (row as { properties?: Record<string, unknown> }).properties ?? {};
        const hits = understanding.propertyHints.filter((h) =>
          matchesHint(props, h)
        ).length;
        return { row, score: n - i + Math.min(hits, 2) * HINT_BOOST };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.row);
  }

  return {
    entities: ordered.slice(0, limit) as Record<string, unknown>[],
    understanding,
    source,
  };
}

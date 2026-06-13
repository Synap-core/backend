/**
 * Graph-propagation retrieval signal (Phase 2) — PPR-lite over the NATIVE
 * relation graph.
 *
 * Given seed entities (the top hybrid-recall hits, weighted by their fused
 * scores), spread weight across relations to surface CONNECTED entities — so
 * "who works at the company in the onboarding deal" reaches the linked
 * person/company even when text recall missed them. This is HippoRAG-class
 * graph retrieval over a graph we ALREADY OWN (no LLM extraction step).
 *
 * The propagation math (buildAdjacency + pprLitePropagate) is PURE and separated
 * from the DB fetch so it is unit-testable without a database.
 *
 * See team/platform/retrieval-architecture.mdx, Phase 2.
 */

import {
  db,
  relations,
  and,
  or,
  eq,
  inArray,
  isNotNull,
} from "@synap/database";

export interface Seed {
  id: string;
  weight: number;
}
export interface Edge {
  src: string;
  tgt: string;
}
export interface GraphHit {
  id: string;
  score: number;
}

/** Undirected adjacency map from an edge list (self-loops + blanks dropped). */
export function buildAdjacency(edges: Edge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = adj.get(a);
    if (!set) {
      set = new Set();
      adj.set(a, set);
    }
    set.add(b);
  };
  for (const e of edges) {
    if (!e.src || !e.tgt || e.src === e.tgt) continue;
    link(e.src, e.tgt);
    link(e.tgt, e.src);
  }
  return adj;
}

/**
 * PPR-lite: seeds carry initial weight; each hop spreads `damping` × a node's
 * weight evenly across its neighbors, over `hops` iterations. Returns neighbor
 * ids (NOT the seeds) ranked by accumulated weight.
 */
export function pprLitePropagate(
  seeds: Seed[],
  adj: Map<string, Set<string>>,
  damping = 0.5,
  hops = 1
): GraphHit[] {
  const seedSet = new Set(seeds.map((s) => s.id));
  const acc = new Map<string, number>();
  let frontier = new Map<string, number>(seeds.map((s) => [s.id, s.weight]));

  for (let h = 0; h < hops; h++) {
    const next = new Map<string, number>();
    for (const [node, w] of frontier) {
      const neighbors = adj.get(node);
      if (!neighbors || neighbors.size === 0) continue;
      const share = (damping * w) / neighbors.size;
      if (share <= 0) continue;
      for (const nb of neighbors) {
        next.set(nb, (next.get(nb) ?? 0) + share);
        if (!seedSet.has(nb)) acc.set(nb, (acc.get(nb) ?? 0) + share);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  return [...acc.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export interface GraphExpandOpts {
  hops?: number;
  damping?: number;
  seedCap?: number;
  /** Inject a fetcher for testing; defaults to the relations DB query. */
  fetchEdges?: (seedIds: string[], userId: string) => Promise<Edge[]>;
}

/** All entity-to-entity relations touching the seed set, user-scoped. */
async function fetchSeedEdges(
  seedIds: string[],
  userId: string
): Promise<Edge[]> {
  if (seedIds.length === 0) return [];
  const rows = await db
    .select({
      src: relations.sourceEntityId,
      tgt: relations.targetEntityId,
    })
    .from(relations)
    .where(
      and(
        eq(relations.userId, userId),
        // entity-to-entity edges only (skip cell endpoints)
        isNotNull(relations.sourceEntityId),
        isNotNull(relations.targetEntityId),
        or(
          inArray(relations.sourceEntityId, seedIds),
          inArray(relations.targetEntityId, seedIds)
        )
      )
    )
    .limit(500); // hard cap — guards against dense graphs in a request path
  return rows
    .filter((r): r is { src: string; tgt: string } => !!r.src && !!r.tgt)
    .map((r) => ({ src: r.src, tgt: r.tgt }));
}

/**
 * Expand seeds across the relation graph → connected entity ids ranked by
 * propagated weight (excluding the seeds). One batched DB query + in-memory
 * propagation (NOT per-node BFS).
 */
export async function graphExpand(
  seeds: Seed[],
  userId: string,
  opts: GraphExpandOpts = {}
): Promise<GraphHit[]> {
  // damping < 1 so each hop contributes strictly less than the seed (a 2-hop hit
  // gets ≤ 0.25× a 1-hop hit, keeping far neighbors quiet); seedCap bounds the
  // `IN (…)` fan-out of the edge query.
  const { hops = 1, damping = 0.5, seedCap = 10 } = opts;
  const topSeeds = seeds.slice(0, seedCap);
  if (topSeeds.length === 0) return [];
  const fetcher = opts.fetchEdges ?? fetchSeedEdges;
  const edges = await fetcher(
    topSeeds.map((s) => s.id),
    userId
  );
  const adj = buildAdjacency(edges);
  return pprLitePropagate(topSeeds, adj, damping, hops);
}

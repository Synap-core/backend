/**
 * PageRank over an entity graph, PURE: no database, no logger, so the CPU
 * pool's worker thread (cpu-tasks.ts) runs it. The worker that reads the
 * edges and stores the scores is `workers/pagerank-centrality.ts` (its header
 * says why the graph is symmetrized).
 */

export interface Edge {
  src: string;
  tgt: string;
}

/** PageRank damping factor (standard 0.85). */
const DAMPING = 0.85;
/** Hard cap on iterations — PageRank converges well within this for a small graph. */
const MAX_ITERATIONS = 30;
/** Early-exit when the summed absolute change across all nodes drops below this. */
const EPSILON = 1e-6;
/**
 * Symmetric out-neighbor adjacency from an edge list. Self-loops and blanks are
 * dropped; each edge is added in BOTH directions (see header — directionality).
 * A Set per node dedups parallel edges so a repeated relation doesn't skew mass.
 */
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
 * In-memory PageRank over the (symmetrized) adjacency. Returns raw PageRank mass
 * per node (sums to ~1). Damping 0.85, bounded iterations, early-exit on L1
 * convergence, dangling mass redistributed uniformly. PURE — no DB. Exported for
 * unit testing.
 */
export function pageRank(adj: Map<string, Set<string>>): Map<string, number> {
  const nodes = Array.from(adj.keys());
  const n = nodes.length;
  const scores = new Map<string, number>();
  if (n === 0) return scores;

  const base = 1 / n;
  for (const node of nodes) scores.set(node, base);

  const teleport = (1 - DAMPING) / n;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Dangling mass — nodes with no out-neighbors spread their rank uniformly.
    // After symmetrization every node in `adj` has ≥1 neighbor, so this is
    // defensive (stays 0 in practice) but keeps the distribution normalized.
    let danglingMass = 0;
    for (const node of nodes) {
      if ((adj.get(node)?.size ?? 0) === 0) danglingMass += scores.get(node)!;
    }
    const danglingShare = (DAMPING * danglingMass) / n;

    const next = new Map<string, number>();
    for (const node of nodes) next.set(node, teleport + danglingShare);

    for (const node of nodes) {
      const neighbors = adj.get(node);
      if (!neighbors || neighbors.size === 0) continue;
      const share = (DAMPING * scores.get(node)!) / neighbors.size;
      for (const nb of neighbors) {
        next.set(nb, (next.get(nb) ?? 0) + share);
      }
    }

    let delta = 0;
    for (const node of nodes) {
      delta += Math.abs(next.get(node)! - scores.get(node)!);
      scores.set(node, next.get(node)!);
    }
    if (delta < EPSILON) break;
  }

  return scores;
}

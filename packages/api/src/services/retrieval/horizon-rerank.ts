/**
 * Horizon re-rank — the new lens-weighted scorer (Phase 2), kept PURE so its
 * weighting is unit-testable in isolation (same discipline as composite-rerank).
 *
 * Per-candidate signals, each normalized to [0,1] over the pool:
 *   R  recency        = exp(-ln2·Δt/halfLife) = 2^(-ageDays/halfLife) from the
 *                       event-chain last-touch (falls back to `updatedAt`).
 *   F  reinforcement  = log(1+viewCount) / log(1+maxViewCount).
 *   C  centrality     = global PageRank / max (from entity_centrality, computed
 *                       by the pagerank-centrality batch job). Falls back to the
 *                       graph-propagation-weight proxy until the job has run.
 *   Q  query relevance= fused recall position (top = 1), already in `rows` order.
 *   L  lens PageRank  = 0 THIS PHASE (Phase 3 batch job — see TODO below).
 * A validity gate (1 live / 0.1 deleted) multiplies the weighted sum.
 *
 * Weights + half-life are chosen BY LENS (project vs workspace). Because L is
 * folded to 0 this phase, the remaining weights are applied AS GIVEN (NOT
 * renormalized) — the intent of the missing L weight is deferred, not
 * reallocated.
 */

export type HorizonLens = "project" | "workspace";

export interface HorizonWeights {
  R: number;
  F: number;
  C: number;
  Q: number;
  L: number;
}

/**
 * Confirmed lens→weight mapping. L is the deferred lens-PageRank signal, folded
 * to 0 this phase; its intended weight is noted so Phase 3 can restore it.
 */
export const HORIZON_WEIGHTS: Record<HorizonLens, HorizonWeights> = {
  // project lens intent: { C .35, L .25, F .2, R .1, Q .1 } — L folded to 0.
  project: { C: 0.35, F: 0.2, R: 0.1, Q: 0.1, L: 0 },
  // workspace lens intent: { R .35, F .25, Q .25, C .1, L .05 } — L folded to 0.
  workspace: { R: 0.35, F: 0.25, Q: 0.25, C: 0.1, L: 0 },
};

/** Recency half-life: long memory under a project lens, short under workspace. */
export const HORIZON_HALF_LIFE_DAYS: Record<HorizonLens, number> = {
  project: 90,
  workspace: 14,
};

export interface HorizonRow {
  id: string;
  updatedAt: Date | string | null;
  deletedAt?: Date | string | null;
}

export interface HorizonOpts {
  lens: HorizonLens;
  now: number;
  /** viewCount per entity id (reinforcement F). Missing ⇒ 0. */
  viewCounts: Map<string, number>;
  /** event-chain last-touch per id; falls back to `row.updatedAt` (recency R). */
  lastTouch: Map<string, Date>;
  /** centrality C per id — global PageRank (entity_centrality), else the graph
   * propagation-weight proxy fallback. Raw scores; normalized here. Missing ⇒ 0. */
  centrality: Map<string, number>;
}

export interface HorizonScored<T> {
  row: T;
  score: number;
}

const DAY_MS = 86_400_000;

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** R in [0,1]: 2^(-ageDays/halfLife). Future-dated → 1; missing/unparseable → 0. */
function recency(ts: Date | null, now: number, halfLifeDays: number): number {
  if (!ts) return 0;
  const ageDays = (now - ts.getTime()) / DAY_MS;
  if (ageDays <= 0) return 1;
  return Math.pow(2, -ageDays / halfLifeDays);
}

/**
 * Score the fused candidate pool (in fused order — the first row is the top
 * recall hit). Returns rows sorted by descending Horizon score, stable on ties
 * (falls back to fused position). Pure; no DB.
 */
export function horizonScore<T extends HorizonRow>(
  rows: T[],
  opts: HorizonOpts
): HorizonScored<T>[] {
  const n = rows.length;
  const w = HORIZON_WEIGHTS[opts.lens];
  const halfLife = HORIZON_HALF_LIFE_DAYS[opts.lens];

  // Pool-relative normalizers (empty spread → 0).
  const maxViews = Math.max(
    0,
    ...rows.map((r) => opts.viewCounts.get(r.id) ?? 0)
  );
  const maxCentrality = Math.max(
    0,
    ...rows.map((r) => opts.centrality.get(r.id) ?? 0)
  );
  const lnMaxViews = Math.log(1 + maxViews);

  return rows
    .map((row, i) => {
      // Q — fused recall position, normalized so the top hit = 1.
      const Q = n <= 1 ? 1 : (n - 1 - i) / (n - 1);
      // R — recency from the event-chain last-touch, else `updatedAt`.
      const ts = opts.lastTouch.get(row.id) ?? toDate(row.updatedAt);
      const R = recency(ts, opts.now, halfLife);
      // F — reinforcement, log-compressed then normalized to the pool max.
      const vc = opts.viewCounts.get(row.id) ?? 0;
      const F = lnMaxViews > 0 ? Math.log(1 + vc) / lnMaxViews : 0;
      // C — global PageRank centrality (or the propagation-weight fallback),
      // normalized to the pool max.
      const cRaw = opts.centrality.get(row.id) ?? 0;
      const C = maxCentrality > 0 ? cRaw / maxCentrality : 0;
      // L — lens PageRank. 0 this phase; Phase 3 batch job populates it.
      // TODO(Phase 3): compute lens-scoped PageRank and restore the L weight.
      const L = 0;
      // Validity gate — deleted rows are heavily damped. `fetchOrdered` already
      // excludes deletedAt, so in practice this stays 1 (defense-in-depth).
      const validity = toDate(row.deletedAt) ? 0.1 : 1;

      const score =
        validity * (w.R * R + w.F * F + w.C * C + w.Q * Q + w.L * L);
      return { row, i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ row, score }) => ({ row, score }));
}

/** Convenience: the Horizon ordering without the per-row scores. */
export function horizonRerank<T extends HorizonRow>(
  rows: T[],
  opts: HorizonOpts
): T[] {
  return horizonScore(rows, opts).map((x) => x.row);
}

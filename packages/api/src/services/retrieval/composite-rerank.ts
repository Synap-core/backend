/**
 * Composite re-rank — the engine's final ordering, extracted PURE so the
 * "bounded nudge, never a partition" invariant is unit-testable (the riskiest
 * part of retrieve()).
 *
 * Fused position is the primary signal. The property-hint and temporal-recency
 * boosts are bounded to a FRACTION OF THE POSITION SPAN, not absolute rank
 * counts — so no boost combination can move a row past more than a fixed
 * fraction of the field at ANY pool size. A fixed +6 would fully reorder a
 * 4-item set (override RRF wholesale); span-relative boosts can't.
 */
import { matchesHint } from "./property-hint-match.js";
import { recencyScore } from "./temporal-signal.js";
import type { PropertyHint } from "./understand-query.js";

/** A single signal (property hit OR max recency) lifts a row up to this share of
 *  the position span — meaningful, but bounded. */
export const SINGLE_FRACTION = 0.4;
/** Property + temporal together are capped at this share, so even both maxed on
 *  the bottom row cannot reach the top — RRF stays the primary ranking. */
export const COMBINED_CAP = 0.5;

export interface RerankRow {
  id: string;
  /** Entity jsonb properties (the column type is `unknown`; cast at use). */
  properties: unknown;
  updatedAt: Date | string | null;
}

export interface RerankOpts {
  propertyHints: PropertyHint[];
  temporal: boolean;
  now: number;
  /** Latest event timestamp per entity id (recency grounding). */
  eventTs?: Map<string, Date>;
}

export function compositeRerank<T extends RerankRow>(
  rows: T[],
  opts: RerankOpts
): T[] {
  const n = rows.length;
  if (n <= 1) return rows;
  const span = Math.max(1, n - 1); // position range: top = n-1 … bottom = 0

  return rows
    .map((row, i) => {
      let boost = 0;
      if (opts.propertyHints.length > 0) {
        const props = (row.properties as Record<string, unknown> | null) ?? {};
        if (opts.propertyHints.some((h) => matchesHint(props, h))) {
          boost += span * SINGLE_FRACTION;
        }
      }
      if (opts.temporal) {
        boost +=
          recencyScore(row, opts.now, opts.eventTs?.get(row.id)) *
          span *
          SINGLE_FRACTION;
      }
      boost = Math.min(boost, span * COMBINED_CAP);
      return { row, i, score: n - i + boost }; // fused position is primary
    })
    .sort((a, b) => b.score - a.score || a.i - b.i) // stable on ties
    .map((x) => x.row);
}

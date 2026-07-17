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
/** A high-signal entity TYPE (knowledge / decision / north_star) lifts a row by
 *  this smaller share — a modest salience nudge over untyped / note rows, never
 *  enough to dominate the fused position. */
export const SALIENCE_FRACTION = 0.2;
/** All boosts together are capped at this share, so even every signal maxed on
 *  the bottom row cannot reach the top — RRF stays the primary ranking. */
export const COMBINED_CAP = 0.5;

/**
 * Entity types that carry durable, high-signal knowledge — a "what do I know"
 * query should surface these over an untyped capture or a raw `note`. Bounded
 * so it only breaks ties in the recall pool, never overrides relevance.
 */
export const SALIENT_TYPES = new Set([
  "knowledge",
  "north_star",
  "decision",
  "devplane_decision_record",
]);

export interface RerankRow {
  id: string;
  /** Entity jsonb properties (the column type is `unknown`; cast at use). */
  properties: unknown;
  updatedAt: Date | string | null;
  /** Entity type/profile slug — drives the bounded salience nudge (optional). */
  type?: string | null;
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
      // Type salience — a modest, bounded nudge for high-signal knowledge types
      // over untyped / note rows. Additive with the others, then jointly capped.
      if (row.type && SALIENT_TYPES.has(row.type)) {
        boost += span * SALIENCE_FRACTION;
      }
      boost = Math.min(boost, span * COMBINED_CAP);
      return { row, i, score: n - i + boost }; // fused position is primary
    })
    .sort((a, b) => b.score - a.score || a.i - b.i) // stable on ties
    .map((x) => x.row);
}

/**
 * Rejection-reason bucketing + fault CLASSIFICATION — the shared leaf both the
 * agent scorecard's histogram and the tighten recommender's classifier read.
 *
 * WHY A LEAF MODULE: `computeAgentScorecard` (services/diagnose/agent-scorecard.ts)
 * grew this precedence rule inline. The tighten recommender needs the SAME rule —
 * a second copy is exactly the drift that produced the six scattered dedup
 * implementations we already paid for. DB-free and dependency-free on purpose so
 * anything can import it.
 *
 * `agent-scorecard.ts` now imports `proposalReasonBucket` from here — there is
 * exactly ONE copy of the precedence rule. Do not re-inline it: the histogram and
 * the classifier must agree on what a rejection means.
 */

import { PROPOSAL_REJECTION_REASONS } from "@synap-core/types";

/** The pinned taxonomy as a set — the structured half of the precedence. */
const KNOWN_REASON_CODES: ReadonlySet<string> = new Set(
  PROPOSAL_REJECTION_REASONS
);

/**
 * The bucket a rejected proposal contributes to.
 *
 * Precedence: the structured `reasonCode` (migration 0232) when it is one of the
 * pinned taxonomy values; otherwise the trimmed, lowercased free-text
 * `rejectionReason` (rows older than 0232 must not vanish). A free-text value
 * that happens to equal a known code ("duplicate") collapses into that code's
 * bucket for free via the same lowercase compare — no fuzzy matching beyond that.
 *
 * Returns `undefined` when the rejection carries NO reason at all. Callers must
 * NOT invent one: an unreasoned rejection is `UNKNOWN_REASON`, never a guess.
 */
export function proposalReasonBucket(
  reasonCode: string | null | undefined,
  rejectionReason: string | null | undefined
): string | undefined {
  if (reasonCode && KNOWN_REASON_CODES.has(reasonCode)) return reasonCode;
  const freeText = rejectionReason?.trim().toLowerCase();
  return freeText || undefined;
}

/** Bucket key for a rejection that carries no reason at all. NEVER fabricated. */
export const UNKNOWN_REASON = "unknown";

/**
 * MECHANICAL faults — reasons that say the agent produced a MALFORMED write, not
 * an unwanted one. The correction belongs on the cheapest durable surface (tool
 * schema / idempotency key / tool description / error string), NOT in policy.
 *
 * Why these three:
 *   - `duplicate`         — the agent re-created something that already exists.
 *                           The fix is an existence check / idempotency key in
 *                           the tool. Pinning the motif to `propose` fixes
 *                           NOTHING: the duplicates are already pending review;
 *                           it just makes a human hand-reject them forever.
 *   - `wrong_kind_or_facet` — the agent spun up an entity for a ROLE instead of
 *                           attaching a facet. Deterministic and knowable at call
 *                           time (`list_profiles` exposes `profileKind`); it is a
 *                           tool-contract gap, not a judgment call.
 *   - `wrong_link_type`   — the agent used a relation type that does not apply.
 *                           The valid set is enumerable, so this belongs in the
 *                           tool's schema/enum, not behind a review gate.
 *
 * Everything else (`wrong_entity`, `wrong_workspace`, `bad_data`, `not_relevant`,
 * `other`, any free text, and `unknown`) is a JUDGMENT fault: the write was
 * well-formed but unwanted. That IS what a `propose` rule is for, so those keep
 * filing `governance.tighten_lane`.
 */
export const MECHANICAL_REJECTION_REASONS: ReadonlySet<string> = new Set([
  "duplicate",
  "wrong_kind_or_facet",
  "wrong_link_type",
]);

export type RejectionFaultClass = "mechanical" | "judgment";

/**
 * Classify a bucket. `unknown` (and any free text we cannot map) is JUDGMENT by
 * design — the fallback must be TODAY's behaviour, never a guess that silently
 * suppresses a rule the humans would have wanted.
 */
export function classifyRejectionReason(bucket: string): RejectionFaultClass {
  return MECHANICAL_REJECTION_REASONS.has(bucket) ? "mechanical" : "judgment";
}

/**
 * The single most common bucket in a histogram.
 *
 * Deterministic tie-break: `UNKNOWN_REASON` wins a tie (a tie means we do not
 * have enough signal to RECLASSIFY, so fall back to the rule path), otherwise
 * lexicographic — never map iteration order, which would make the classification
 * depend on row ordering.
 */
export function dominantReason(histogram: ReadonlyMap<string, number>): string {
  let best = UNKNOWN_REASON;
  let bestCount = -1;
  for (const [bucket, count] of histogram) {
    if (count > bestCount) {
      best = bucket;
      bestCount = count;
      continue;
    }
    if (count !== bestCount) continue;
    if (best === UNKNOWN_REASON) continue;
    if (bucket === UNKNOWN_REASON || bucket < best) best = bucket;
  }
  return best;
}

/**
 * Capture-routing tunables — the SINGLE SOURCE for the numbers the routing gate
 * and the observability metric share. `lib/ai-events` re-exports everything
 * here, so importers can keep pulling tunables from `ai-events` alongside the
 * event vocabulary.
 *
 * Wave 1 note: the two GATE constants (`AUTO_ROUTE_MIN_CONFIDENCE`,
 * `BYOA_DEFAULT_ROUTE_CONFIDENCE`) now live in @synap/database (the pure
 * capture-routing gate moved there beside the `WorkspaceResolutionService` door)
 * and are re-exported here so this stays their public surface — the derived
 * constants below reference them.
 */

// Gate SSOT moved to @synap/database; re-exported so this remains the tunables surface.
export {
  AUTO_ROUTE_MIN_CONFIDENCE,
  BYOA_DEFAULT_ROUTE_CONFIDENCE,
} from "@synap/database";
import { AUTO_ROUTE_MIN_CONFIDENCE } from "@synap/database";

/** Ceiling for the per-workspace auto-tuned gate (a mis-route-prone workspace earns up to this bar). */
export const ROUTE_TUNING_CEIL = 0.9;
/** Derived confidence when name→id reconciliation matched a workspace name EXACTLY. */
export const EXACT_MATCH_CONFIDENCE = 0.9;
/**
 * Derived confidence for a FUZZY/substring reconciliation match. Deliberately
 * just above AUTO_ROUTE_MIN_CONFIDENCE so a fuzzy pick still auto-applies — kept
 * beside the floor so the coupling is visible, not a buried footgun.
 */
export const FUZZY_MATCH_CONFIDENCE = 0.65;
/**
 * A deliberately below-the-floor confidence, assigned when a routing pick is
 * UNTRUSTWORTHY (an ambiguous fuzzy match on >1 workspace, or a null name that
 * leaves the id unverifiable) so it degrades to ask/no-move instead of an
 * arbitrary auto-move. Gate-relative so it can't drift from the floor.
 */
export const BELOW_GATE_CONFIDENCE = AUTO_ROUTE_MIN_CONFIDENCE - 0.1;

/**
 * A decision must be at least this old before it counts as "confirmed": it has
 * had a full window to be corrected and wasn't. Used BOTH by the acceptance
 * metric (the matured cohort) AND by routing memory (a positive example must be
 * a SURVIVED route, not a fresh un-looked-at one — otherwise an uncorrected
 * mis-route poisons the few-shot positives, which dogfooding caught live).
 */
export const MATURITY_DAYS = 7;

/** Clamp a caller-supplied lookback window to [1, 365] days (DoS guard + shared default). */
export const clampWindowDays = (
  days: number | undefined,
  fallback = 30
): number => Math.min(365, Math.max(1, days ?? fallback));

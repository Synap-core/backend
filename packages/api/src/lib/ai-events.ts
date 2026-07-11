/**
 * AI-events vocabulary + capture-routing tunables — the SINGLE SOURCE for the
 * strings and numbers the self-improvement flywheel spreads across many hands.
 *
 * WHY this exists: the decision↔correction spine is read by 3 query sites
 * (observability, routing-memory ×2) and written by 4 emit sites (capture,
 * entities move/delete, proposals revert). The `subjectType` strings, the
 * `data.kind` discriminators, and — most dangerously — the JOIN KEY expression
 * (`data->>'correlationId'`, the DECISION's id nested inside a correction's
 * `data`, NOT the row's own `correlation_id` column) were hand-typed as raw
 * strings at every site. A typo (`"ai_corrections"`, `"routes"`) or a drift in
 * the key extraction would silently break the flywheel with NO type error —
 * exactly the failure class SSOT constants prevent.
 *
 * This is a dependency-free LEAF module (imports only drizzle + the events
 * table): it also breaks the `capture.ts ↔ routing-memory.ts` cycle that the
 * shared `AUTO_ROUTE_MIN_CONFIDENCE` floor would otherwise create.
 */

import { events, drizzleSql } from "@synap/database";

// ── Event vocabulary ────────────────────────────────────────────────────────
/** `events.subject_type` for a routing/extraction decision the AI made. */
export const AI_DECISION = "ai_decision";
/** `events.subject_type` for a user reversal of an AI decision. */
export const AI_CORRECTION = "ai_correction";

/** `data.kind` discriminator — pairs a decision with the correction that reverses it. */
export const AI_KIND = {
  /** Workspace routing (decision) / a move to another workspace (correction). */
  ROUTE: "route",
  /** Entity extraction (decision) / a delete (correction). */
  EXTRACT: "extract",
  /** A whole capture graph (decision) / a revert (correction). */
  CAPTURE: "capture",
} as const;
export type AiKind = (typeof AI_KIND)[keyof typeof AI_KIND];

// ── The JOIN KEY (and friends) — one definition of the fragile JSONB paths ───
/** The DECISION's id carried inside a correction's `data` — THE join key. */
export const decisionCorrelationKeyExpr = drizzleSql<
  string | null
>`${events.data}->>'correlationId'`;
/** The `data.kind` discriminator, extracted from any ai_* event. */
export const eventKindExpr = drizzleSql<string | null>`${events.data}->>'kind'`;

// ── Capture-routing tunables (single-sourced; imported by capture.ts + routing-memory.ts) ──
/** Flat auto-apply floor: below this the AI's workspace guess can't override the ambient workspace. */
export const AUTO_ROUTE_MIN_CONFIDENCE = 0.6;
/** Ceiling for the per-workspace auto-tuned gate (a mis-route-prone workspace earns up to this bar). */
export const ROUTE_TUNING_CEIL = 0.9;
/** Baseline for an explicit direct/BYOA pick that carries no self-reported confidence. */
export const BYOA_DEFAULT_ROUTE_CONFIDENCE = 0.7;
/** Derived confidence when name→id reconciliation matched a workspace name EXACTLY. */
export const EXACT_MATCH_CONFIDENCE = 0.9;
/**
 * Derived confidence for a FUZZY/substring reconciliation match. Deliberately
 * just above AUTO_ROUTE_MIN_CONFIDENCE so a fuzzy pick still auto-applies — kept
 * here beside the floor so the coupling is visible, not a buried footgun.
 */
export const FUZZY_MATCH_CONFIDENCE = 0.65;

/** Clamp a caller-supplied lookback window to [1, 365] days (DoS guard + shared default). */
export const clampWindowDays = (
  days: number | undefined,
  fallback = 30
): number => Math.min(365, Math.max(1, days ?? fallback));

/**
 * A decision must be at least this old before it counts as "confirmed": it has
 * had a full window to be corrected and wasn't. Used BOTH by the acceptance
 * metric (the matured cohort) AND by routing memory (a positive example must be
 * a SURVIVED route, not a fresh un-looked-at one — otherwise an uncorrected
 * mis-route poisons the few-shot positives, which dogfooding caught live).
 */
export const MATURITY_DAYS = 7;

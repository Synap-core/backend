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
/**
 * `events.subject_type` for a self-diagnosis TRACE — a point where the capture
 * pipeline silently dropped/degraded/coerced something (a facet, an entity, a
 * relation, content). Keyed by the capture's `correlationId` (the captureId) so
 * the operating AI (and the user) can ask "what happened to this capture and
 * WHY" via a door instead of SSH-ing the host. Best-effort, never fails capture.
 */
export const AI_PROCESSING = "ai_processing";
/** `data.kind` for an AI_PROCESSING event — a captured self-diagnosis trace. */
export const CAPTURE_TRACE_KIND = "capture_trace";

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
/** The freeform human rejection reason, extracted from an `ai_correction`'s `data`. */
export const reasonExpr = drizzleSql<string | null>`${events.data}->>'reason'`;
/** The structured rejection taxonomy code, extracted from an `ai_correction`'s `data`. */
export const reasonCodeExpr = drizzleSql<
  string | null
>`${events.data}->>'reasonCode'`;

// ── Capture-routing tunables ────────────────────────────────────────────────
// Re-exported from the zero-dependency `routing-tunables` leaf so importers can
// keep pulling them from `ai-events` alongside the event vocabulary, while the
// pure numbers stay unit-testable without this module's `@synap/database` chain.
export * from "./routing-tunables.js";

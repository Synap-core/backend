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
 * `events.subject_type` for a user ENDORSING an AI decision after the fact —
 * e.g. moving a captured entity INTO the workspace its route decision
 * suggested (the suggestion stayed a proposal; the person later took it).
 * Same join key as a correction (`data.correlationId` = the DECISION's id).
 * Deliberately NOT an `ai_correction`: every correction reader counts those as
 * the AI being wrong.
 */
export const AI_CONFIRMATION = "ai_confirmation";
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
  /**
   * PROJECT placement (decision) / an unfile (correction) — the cross-cutting
   * dimension. A DISTINCT kind (not `route`) so the workspace routing-memory +
   * observability queries, which filter `kind = route`, never mistake a project
   * placement for a workspace route. Project events additionally carry
   * `data.dim: "project"` so a future shared reader can filter by dimension.
   */
  PROJECT: "project",
} as const;
export type AiKind = (typeof AI_KIND)[keyof typeof AI_KIND];

// ── Decision distribution — WHO decided a workspace route, and how sure ─────
/**
 * What the IS workspace-decision door (`/api/workspace-tiebreak`) reported for
 * the pick a capture carried: which decider answered (`jev` = the TypeSafe
 * decision model, `llm` = the cascade fallback), the model, the probability
 * per candidate workspace id (+ `none` for JEV's abstain outcome), and the
 * candidate set it was asked over. Recorded on the `route` decision event so
 * a later correction joins (by correlationId) to the full distribution — the
 * calibration sample "p=0.83 for X, user moved it to Y".
 *
 * ONE definition, shared with every capture door: `@synap-core/types`
 * (`capture-routing-types.ts`). Re-exported here, never redeclared.
 */
import type { WorkspaceDecisionRecord } from "@synap-core/types";
export type { WorkspaceDecisionRecord };

/** `data` keys for a {@link WorkspaceDecisionRecord} on a route decision. */
const DATA_DECIDER = "decider";
const DATA_DECISION_MODEL = "decisionModel";
const DATA_PROBABILITIES = "probabilities";
const DATA_CANDIDATES = "candidates";

/**
 * The route event's decision-distribution fields. Uses ONLY keys the route
 * event does not already carry, so spreading it can never overwrite the
 * event's own `confidence` / `reason` / `chosenWorkspaceId`. No record ⇒ no
 * fields — an absent distribution is recorded as absent, never as `{}`.
 */
export function workspaceDecisionEventData(
  decision: WorkspaceDecisionRecord | null | undefined
): Record<string, unknown> {
  if (!decision) return {};
  return {
    [DATA_DECIDER]: decision.decider,
    ...(decision.model ? { [DATA_DECISION_MODEL]: decision.model } : {}),
    ...(decision.probabilities
      ? { [DATA_PROBABILITIES]: decision.probabilities }
      : {}),
    ...(decision.candidates?.length
      ? { [DATA_CANDIDATES]: decision.candidates }
      : {}),
  };
}

// ── The JOIN KEY (and friends) — one definition of the fragile JSONB paths ───
/** The DECISION's id carried inside a correction's `data` — THE join key. */
export const decisionCorrelationKeyExpr = drizzleSql<
  string | null
>`${events.data}->>'correlationId'`;
/** The `data.kind` discriminator, extracted from any ai_* event. */
export const eventKindExpr = drizzleSql<string | null>`${events.data}->>'kind'`;
/**
 * WHO decided a route decision — `data.decider` (`jev` | `llm`, see
 * {@link workspaceDecisionEventData}). A route event recorded before deciders
 * existed has no key and was an LLM pick, so it reads as `llm`.
 */
export const routeDeciderExpr = drizzleSql<string>`coalesce(${events.data}->>${DATA_DECIDER}::text, 'llm')`;
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

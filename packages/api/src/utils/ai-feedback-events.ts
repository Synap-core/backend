/**
 * AI feedback events — the observability flywheel's write primitives.
 *
 * Two event kinds, linked by ONE `correlationId`:
 *   - `ai_decision`  — the AI made a routing/extraction decision. The
 *     correlationId is the decision's identity (its own event + the entities it
 *     stamped share it), carried in the event's top-level `correlationId`.
 *   - `ai_correction` — the user later reversed that decision (moved / deleted /
 *     reverted). The DECISION's correlationId is the JOIN KEY and MUST live
 *     inside `data.correlationId` — NOT the correction row's own
 *     `correlation_id` column (which belongs to the move/delete's own event
 *     chain). The `emitAiCorrection` signature makes that structural: `data`
 *     is typed to require `correlationId`, so a new call site can't get the
 *     fragile nesting wrong (the mistake this helper exists to prevent).
 *
 * BOTH are best-effort by contract: they swallow + log and NEVER throw, so a
 * telemetry hiccup can never fail the underlying capture/move/delete/revert.
 */

import { randomUUID } from "crypto";
import { auditLog } from "./audit-log.js";
import {
  AI_DECISION,
  AI_CORRECTION,
  AI_CONFIRMATION,
  AI_KIND,
  AI_PROCESSING,
  CAPTURE_TRACE_KIND,
  eventKindExpr,
} from "../lib/ai-events.js";
import { createLogger } from "@synap-core/core";
import {
  and,
  db,
  drizzleSql,
  eq,
  events,
  isConnectionSyncProposal,
} from "@synap/database";

const logger = createLogger({ module: "ai-feedback-events" });

/**
 * Whether a correction targets a connection-sync import (`data.connectionSync`).
 * Its operations come from a deterministic provider mapper, not a model, so
 * rejecting them corrects no AI decision.
 *
 * A whole-proposal reject names the proposal as `subjectId`. A per-item reject
 * names only the item; its `correlationId` is the proposal's correlation column
 * or, when that is empty (a sync import leaves it empty), the proposal id — so
 * either id may be the proposal. Each check is a primary-key read, and an id
 * that is not a uuid is answered without a query.
 */
async function correctsConnectionSyncImport(
  subjectId: string,
  correlationId: string
): Promise<boolean> {
  return (
    (await isConnectionSyncProposal(subjectId, db)) ||
    (await isConnectionSyncProposal(correlationId, db))
  );
}

/**
 * Record an AI decision (e.g. a capture-routing pick). `correlationId` becomes
 * the decision's identity — stamp the SAME value on the entities it produced so
 * a future `ai_correction` can join back to it.
 */
export async function emitAiDecision(opts: {
  action: string;
  userId: string;
  workspaceId?: string | null;
  correlationId: string;
  /**
   * The focus session this decision belongs to → the event row's `session_id`
   * COLUMN (0241), forwarded to the ONE event writer. Absent → the decision
   * happened outside any session; NEVER synthesise one.
   */
  sessionId?: string | null;
  data: Record<string, unknown> & { kind: string };
}): Promise<void> {
  try {
    await auditLog({
      subjectType: AI_DECISION,
      action: opts.action,
      phase: "completed",
      // No single subject row — the join is via `correlationId`.
      subjectId: randomUUID(),
      userId: opts.userId,
      workspaceId: opts.workspaceId ?? null,
      sessionId: opts.sessionId ?? null,
      source: "api",
      correlationId: opts.correlationId,
      data: opts.data,
    });
  } catch (err) {
    logger.warn(
      { err, userId: opts.userId, kind: opts.data.kind },
      "ai_decision emit failed (operation preserved)"
    );
  }
}

/**
 * Record a user correction of an AI decision. `data.correlationId` MUST be the
 * DECISION's id (the join key) — enforced by the type. Pass the corrected
 * subject as `subjectId` (the entity/proposal id).
 */
export async function emitAiCorrection(opts: {
  action: string;
  userId: string;
  subjectId: string;
  workspaceId?: string | null;
  agentUserId?: string | null;
  data: Record<string, unknown> & { kind: string; correlationId: string };
}): Promise<void> {
  try {
    if (
      await correctsConnectionSyncImport(
        opts.subjectId,
        opts.data.correlationId
      )
    ) {
      return;
    }
  } catch (err) {
    // Unknown is not "not a sync import": the correction is recorded as before.
    logger.warn(
      { err, subjectId: opts.subjectId },
      "ai_correction: could not tell whether the subject is a connection-sync import; recording it"
    );
  }
  try {
    await auditLog({
      subjectType: AI_CORRECTION,
      action: opts.action,
      phase: "completed",
      subjectId: opts.subjectId,
      userId: opts.userId,
      agentUserId: opts.agentUserId ?? undefined,
      workspaceId: opts.workspaceId ?? undefined,
      source: "api",
      data: opts.data,
    });
  } catch (err) {
    logger.warn(
      { err, subjectId: opts.subjectId, kind: opts.data.kind },
      "ai_correction emit failed (operation preserved)"
    );
  }
}

/**
 * The workspace a route decision CHOSE (its `chosenWorkspaceId` — the AI's
 * pick or pending suggestion), joined by the decision's correlationId. `null`
 * = no route decision under that id.
 */
async function routeDecisionChosenWorkspace(
  userId: string,
  correlationId: string
): Promise<string | null> {
  const [row] = await db
    .select({
      chosen: drizzleSql<string | null>`${events.data}->>'chosenWorkspaceId'`,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.subjectType, AI_DECISION),
        eq(events.correlationId, correlationId),
        drizzleSql`${eventKindExpr} = ${AI_KIND.ROUTE}`
      )
    )
    .limit(1);
  return row?.chosen ?? null;
}

/**
 * The feedback a human MOVE of an AI-placed entity carries — the one decision
 * for every move door. Moving it INTO the workspace its route decision chose
 * (the suggestion that stayed a proposal) ENDORSES the AI: an
 * `ai_confirmation`, never a correction. Any other move reroutes away from the
 * AI's choice: a `route` correction, exactly as before. An unreadable decision
 * falls back to the correction (the pre-existing behaviour), logged.
 * Best-effort, never throws.
 */
export async function emitRouteMoveFeedback(opts: {
  userId: string;
  entityId: string;
  fromWorkspaceId: string | null;
  toWorkspaceId: string;
  /** The DECISION's id, stamped on the entity at capture. */
  correlationId: string;
}): Promise<"confirmation" | "correction"> {
  const data = {
    kind: AI_KIND.ROUTE,
    entityId: opts.entityId,
    fromWorkspaceId: opts.fromWorkspaceId,
    toWorkspaceId: opts.toWorkspaceId,
    correlationId: opts.correlationId,
  };
  let chosen: string | null = null;
  try {
    chosen = await routeDecisionChosenWorkspace(
      opts.userId,
      opts.correlationId
    );
  } catch (err) {
    logger.warn(
      { err, entityId: opts.entityId },
      "route move feedback: decision lookup failed — recording a correction"
    );
  }
  if (chosen && chosen === opts.toWorkspaceId) {
    try {
      await auditLog({
        subjectType: AI_CONFIRMATION,
        action: "accept_suggestion",
        phase: "completed",
        subjectId: opts.entityId,
        userId: opts.userId,
        workspaceId: opts.toWorkspaceId,
        source: "api",
        data,
      });
    } catch (err) {
      logger.warn(
        { err, entityId: opts.entityId },
        "ai_confirmation emit failed (operation preserved)"
      );
    }
    return "confirmation";
  }
  await emitAiCorrection({
    action: "reroute",
    userId: opts.userId,
    subjectId: opts.entityId,
    workspaceId: opts.toWorkspaceId,
    data,
  });
  return "correction";
}

/**
 * Record a self-diagnosis TRACE — a point where the capture pipeline silently
 * dropped/degraded/coerced something. Keyed by `captureId` (the capture's
 * correlationId) so a diagnose door can return the whole capture's story. Every
 * trace carries a machine-readable `reason` + a `fixHint` so both the AI and the
 * user get "here's what happened and what to do." Best-effort: NEVER throws, so
 * instrumenting a drop can't regress the zero-friction capture guarantee.
 */
export async function emitCaptureTrace(opts: {
  captureId: string;
  userId: string;
  workspaceId?: string | null;
  /** Which pipeline stage: "facet_attach" | "slug_coerce" | "materialize_skip" | … */
  component: string;
  /** Machine-readable cause: "kind_mismatch" | "not_in_creatable_catalog" | … */
  reason: string;
  /** The affected entity/tempId, when there is one. */
  subjectId?: string;
  /** A one-line, actionable fix hint for the AI/user. */
  fixHint?: string;
  /** Extra structured detail (e.g. applicableKinds, fromSlug/toSlug). */
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await auditLog({
      subjectType: AI_PROCESSING,
      action: opts.component,
      phase: "completed",
      subjectId: opts.subjectId ?? opts.captureId,
      userId: opts.userId,
      workspaceId: opts.workspaceId ?? undefined,
      source: "api",
      // The captureId is the join key — carried in BOTH the column and data.kind's
      // sibling so the diagnose door can group a whole capture's trace by it.
      correlationId: opts.captureId,
      data: {
        kind: CAPTURE_TRACE_KIND,
        component: opts.component,
        reason: opts.reason,
        ...(opts.fixHint ? { fixHint: opts.fixHint } : {}),
        ...(opts.detail ?? {}),
        correlationId: opts.captureId,
      },
    });
  } catch (err) {
    logger.warn(
      { err, captureId: opts.captureId, component: opts.component },
      "capture trace emit failed (operation preserved)"
    );
  }
}

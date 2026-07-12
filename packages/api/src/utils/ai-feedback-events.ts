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
  AI_PROCESSING,
  CAPTURE_TRACE_KIND,
} from "../lib/ai-events.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "ai-feedback-events" });

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

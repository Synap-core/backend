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
      subjectType: "ai_decision",
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
      subjectType: "ai_correction",
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

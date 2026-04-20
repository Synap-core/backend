/**
 * Audit Log Helper
 *
 * Appends events to the events table for audit trail purposes.
 * Replaces emitRequestEvent for audit-only logging.
 */

import { EventRepository, sql } from "@synap/database";
import { createUnifiedEvent } from "@synap/jobs";
import type { SubjectType, EventAction, EventPhase } from "@synap/jobs";

export interface AuditLogOpts {
  subjectType: string;
  action: string;
  phase: string;
  subjectId: string;
  userId: string;
  /** Pass null for workspace-less (hydration / pod-wide) operations. */
  workspaceId?: string | null;
  data?: Record<string, unknown>;
  source?: string;
  correlationId?: string;
}

/**
 * Append an audit log entry to the events table.
 * Fire-and-forget — failures are logged but don't propagate.
 */
export async function auditLog(opts: AuditLogOpts): Promise<void> {
  try {
    const eventRepo = new EventRepository(sql);

    const event = createUnifiedEvent({
      subjectType: opts.subjectType as SubjectType,
      action: opts.action as EventAction,
      phase: opts.phase as EventPhase,
      subjectId: opts.subjectId,
      data: {
        ...opts.data,
        workspaceId: opts.workspaceId ?? undefined,
        userId: opts.userId,
      },
      userId: opts.userId,
      source: (opts.source || "api") as
        | "api"
        | "automation"
        | "sync"
        | "migration"
        | "system"
        | "intelligence"
        | "iot"
        | "enterprise",
      correlationId: opts.correlationId,
    });

    await eventRepo.append({
      id: event.id,
      version: event.version,
      type: event.type,
      subjectId: event.subjectId,
      subjectType: event.subjectType,
      data: event.data as Record<string, unknown>,
      metadata: event.metadata as Record<string, unknown>,
      userId: event.userId,
      // Column is `text` — widen to string for compat between UnifiedEvent and EventRecord source unions
      source: event.source as
        | "api"
        | "automation"
        | "sync"
        | "migration"
        | "system"
        | "intelligence",
      timestamp: event.timestamp,
      correlationId: event.correlationId,
    });
  } catch (error) {
    // Audit logging is non-critical — log and continue
    console.warn("[audit-log] Failed to append audit event:", error);
  }
}

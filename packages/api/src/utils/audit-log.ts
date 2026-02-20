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
  workspaceId?: string;
  data?: Record<string, unknown>;
  source?: string;
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
        workspaceId: opts.workspaceId,
        userId: opts.userId,
      },
      userId: opts.userId,
      source: (opts.source || "api") as any,
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
      source: event.source as any,
      timestamp: event.timestamp,
    });
  } catch (error) {
    // Audit logging is non-critical — log and continue
    console.warn("[audit-log] Failed to append audit event:", error);
  }
}

/**
 * Audit Log Helper
 *
 * Appends events to the events table for audit trail purposes.
 * Replaces emitRequestEvent for audit-only logging.
 */

import { EventRepository, eventRepository, sql } from "@synap/database";
import type { EventRecord } from "@synap/database";
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
  /**
   * The AI-agent identity when this write is agent-attributed. Stamped onto the
   * event row's `agent_user_id` column (and drives `is_agent`) so the realtime
   * presence chain — `domain-event-bridge` → socket → browser ActivityCard /
   * AgentProposalToast — can show "an *agent* did this". Absent → owner write,
   * `is_agent` stays null (byte-identical to legacy events).
   */
  agentUserId?: string | null;
  /**
   * Explicit agent flag. Defaults to `Boolean(agentUserId)` — pass it only to
   * force the flag independently of an agent-user row (legacy AI-source paths).
   */
  isAgent?: boolean;
  /**
   * The proposal an AGENT write went through — auto-approved (an AUTO_APPROVED
   * `proposals` row) OR pending→approved. Stamped onto the event row's
   * `proposal_id` column (0231) so the "ungoverned AI write" blind spot
   * (`is_agent = true AND proposal_id IS NULL`) becomes queryable. Absent → the
   * write executed with no proposal (a direct/ungoverned write, or a human write).
   */
  proposalId?: string | null;
  data?: Record<string, unknown>;
  source?: string;
  correlationId?: string;
  /**
   * When true, a failed append RE-THROWS instead of being swallowed. Use ONLY
   * for governance-critical appends whose success gates downstream state — i.e.
   * the proposal-approval `.validated` event (a swallowed failure there would
   * leave a proposal APPROVED but never materialized). Default false = best-effort.
   */
  throwOnError?: boolean;
}

/**
 * Append an audit log entry to the events table.
 * Fire-and-forget — failures are logged but don't propagate.
 */
export async function auditLog(
  opts: AuditLogOpts
): Promise<EventRecord | null> {
  try {
    // `.validated` appends MUST go through the singleton `eventRepository`, which
    // carries the registered hooks — crucially the materialization hook that
    // enqueues the DB write when a `.validated` event lands. A fresh
    // `new EventRepository(sql)` has an EMPTY hook list, so appending `.validated`
    // through it silently fails to enqueue materialization (the proposal flips to
    // APPROVED but is never written). Other phases keep the fresh instance to
    // avoid double-firing the broadcast/sync hooks (those are driven separately
    // via emitSideEffects / the repositories).
    const eventRepo =
      opts.phase === "validated" ? eventRepository : new EventRepository(sql);

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

    return await eventRepo.append({
      id: event.id,
      version: event.version,
      type: event.type,
      subjectId: event.subjectId,
      subjectType: event.subjectType,
      data: event.data as Record<string, unknown>,
      metadata: event.metadata as Record<string, unknown>,
      userId: event.userId,
      // Workspace context → the real `workspace_id` column (0223). Also kept in
      // `data.workspaceId` above for back-compat; readers COALESCE the two. Null
      // for pod-wide / hydration operations.
      workspaceId: opts.workspaceId ?? undefined,
      // Agent attribution → realtime presence. `is_agent` defaults to whether an
      // agent-user drove the write; both stay null for owner writes.
      isAgent: opts.isAgent ?? (opts.agentUserId ? true : undefined),
      agentUserId: opts.agentUserId ?? undefined,
      // Governance linkage (0231): the proposal this agent write went through.
      // Null for a direct/ungoverned write or any human write.
      proposalId: opts.proposalId ?? undefined,
      // Column is `text` — widen to string for compat between UnifiedEvent and EventRecord source unions
      source: event.source as
        "api" | "automation" | "sync" | "migration" | "system" | "intelligence",
      timestamp: event.timestamp,
      correlationId: event.correlationId,
    });
  } catch (error) {
    // Governance-critical callers (the `.validated` approval event) opt into
    // throwOnError so a failed append surfaces instead of silently leaving a
    // proposal APPROVED-but-unmaterialized. All other callers stay best-effort.
    if (opts.throwOnError) {
      throw error;
    }
    console.warn("[audit-log] Failed to append audit event:", error);
    return null;
  }
}

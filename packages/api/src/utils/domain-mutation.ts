/**
 * recordDomainMutation — the ONE door for a completed domain mutation.
 *
 * A mutation to a first-class subject (entity / relation / role / facet …) has
 * to reach TWO pipes, and until now each door wired them by hand:
 *
 *   1. the immutable event log   — `auditLog({ …, phase: "completed" })`
 *      (feeds the per-record timeline / activity feed / agent-run observability)
 *   2. the side-effect fan-out   — `emitSideEffects({ … })`
 *      (feeds search indexing, webhooks, and — load-bearing — the automation
 *       trigger matcher)
 *
 * Both are keyed on the SAME `event-types.ts` vocabulary: a `.completed` event
 * of `${subjectType}.${action}` in the log, and the trigger eventType
 * `${subjectType}.${action}.completed` in the fan-out. Wiring them separately at
 * ~30 doors means a door can log a change the timeline shows but no automation
 * ever sees (or fire an automation with no timeline row). This helper collapses
 * the pair into one call so the two can never drift apart.
 *
 * Behaviour-preserving contract (do NOT change without updating callers):
 *   - `data`    → the side-effect payload (what the automation matcher + webhooks
 *                 read). This is the automation-visible shape.
 *   - `logData` → the event-log row's `data`. Defaults to `data` when omitted —
 *                 pass it only when the log payload legitimately differs from the
 *                 fan-out payload (e.g. relations log `sourceEntityId` but the
 *                 matcher expects `fromEntityId`).
 *   - The log append is awaited (its EventRecord is returned); the side-effect
 *     fan-out is fire-and-forget (it only enqueues pg-boss jobs and every reactor
 *     self-isolates), matching the dominant hand-wired pattern.
 *
 * This does NOT own the `.requested` / `.validated` governance phases (those
 * remain direct `auditLog` calls — they are not a timeline+automation pair), nor
 * the bare `emitSideEffects` calls that fire WITHOUT a matching log row on
 * purpose (e.g. a facet change's parent-entity refresh, document re-indexing).
 */

import { auditLog } from "./audit-log.js";
import { emitSideEffects, type SideEffectPayload } from "@synap/events";
import type { EventRecord } from "@synap/database";

export interface DomainMutationOpts {
  subjectType: string;
  action: string;
  subjectId: string;
  userId: string;
  /** Pass null for workspace-less (pod-wide) operations. */
  workspaceId?: string | null;
  /** AI-agent identity when this write is agent-attributed (→ event `is_agent`). */
  agentUserId?: string | null;
  /** Force the agent flag independently of an agent-user row (legacy AI paths). */
  isAgent?: boolean;
  /**
   * The proposal an AGENT write went through (auto-approved OR pending→approved)
   * → stamped onto the event's `proposal_id` column (0231). Absent → the write
   * executed with no proposal, so the `.completed` event reads as an "ungoverned
   * AI write" (`is_agent = true AND proposal_id IS NULL`). Only the log event
   * carries it — the side-effect fan-out is unchanged.
   */
  proposalId?: string | null;
  correlationId?: string;
  source?: string;
  /** Focus session that produced this mutation → automation matcher (+ F2 chain floor). */
  sessionId?: string | null;
  /** Automation chain context → the cycle / depth guard. */
  automationContext?: SideEffectPayload["automationContext"];
  /** Side-effect / automation-matcher / webhook payload. */
  data?: Record<string, unknown>;
  /** Event-log payload. Defaults to `data`. */
  logData?: Record<string, unknown>;
  /**
   * Re-throw a failed log append instead of swallowing it. Only for
   * governance-critical appends whose success gates downstream state.
   */
  throwOnError?: boolean;
}

/**
 * Record a completed domain mutation: append the immutable log event AND fan out
 * its side-effects, both keyed on the same `${subjectType}.${action}` vocabulary.
 * Returns the log EventRecord (or null if the best-effort append failed).
 */
export async function recordDomainMutation(
  opts: DomainMutationOpts
): Promise<EventRecord | null> {
  const record = await auditLog({
    subjectType: opts.subjectType,
    action: opts.action,
    phase: "completed",
    subjectId: opts.subjectId,
    userId: opts.userId,
    agentUserId: opts.agentUserId,
    isAgent: opts.isAgent,
    proposalId: opts.proposalId,
    workspaceId: opts.workspaceId,
    correlationId: opts.correlationId,
    source: opts.source,
    data: opts.logData ?? opts.data,
    throwOnError: opts.throwOnError,
  });

  // Fire-and-forget fan-out — emitSideEffects self-isolates every reactor and
  // swallows a missing queue, so this never rejects; the .catch is belt-and-braces.
  emitSideEffects({
    subjectType: opts.subjectType,
    action: opts.action,
    subjectId: opts.subjectId,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    sessionId: opts.sessionId ?? null,
    automationContext: opts.automationContext,
    data: opts.data,
  }).catch(() => {
    /* reactors log their own failures; nothing to do here */
  });

  return record;
}

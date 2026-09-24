/**
 * The capability-run PREDICATES — which rows ARE a capability run a user may
 * see, in each of the two ledgers a run lands in.
 *
 * A capability run has no table of its own. A PROPOSED run is a
 * `capability.run` proposal (`proposals.session_id` stamped by every door that
 * forwards a session); a DIRECT run (owner-bypass / read-only builtin /
 * governance-auto-granted agent) has no proposal at all and is only the
 * `capability_run` ai_decision event `recordDirectCapabilityRun` writes, with
 * its session on the `events.session_id` COLUMN (0241).
 *
 * Extracted from `listCapabilityRuns` (services/runs/index.ts) so the runs feed
 * and `focusSessions.usage` (services/focus-sessions/session-usage.ts) read the
 * SAME rows. Two hand-copied WHERE clauses would be two answers to "what ran in
 * this session" the first time either one grew a condition.
 *
 * NOT here, deliberately: status and refusal. The runs feed shows a refused
 * attempt (as `blocked_by_policy`) and a pending proposal (as `proposed`);
 * usage counts only what actually ran. Those are per-reader decisions layered
 * ON TOP of these predicates, never forks of them.
 */

import { and, or, eq, drizzleSql, proposals, events } from "@synap/database";
import type { SQL } from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { AI_DECISION } from "../../lib/ai-events.js";
import { CAPABILITY_RUN_PROPOSAL_TYPE } from "../proposals/proposal-class.js";

/**
 * `events.data.kind` (and `action`) for a capability run's ai_decision event —
 * the literal BOTH the `capability.run` approve-executor AND the direct-run door
 * (`executeCapability`) emit. A DIRECT run (owner-bypass / read-only builtin /
 * governance-auto-granted agent) has this event but NO proposal, so a reader
 * must synthesise it from the event to make direct runs observable too.
 */
export const CAPABILITY_RUN_EVENT_KIND = "capability_run";

/** The narrowing lens. Every field ANDs; absent = no narrowing on that axis. */
export interface CapabilityRunLens {
  /** Match a run by its correlationId (or, for a proposal, its row id). */
  exactRunId?: string;
  workspaceId?: string;
  /** Proposals only — `events` carries no project column. */
  projectId?: string;
  sessionId?: string;
}

/**
 * PROPOSED runs: `capability.run` proposals the user can see, USER-floored via
 * `userVisibleWhere` (the identical predicate `proposals.list` uses).
 */
export function capabilityRunProposalWhere(
  userId: string,
  lens: CapabilityRunLens = {}
): SQL {
  return and(
    eq(proposals.proposalType, CAPABILITY_RUN_PROPOSAL_TYPE),
    userVisibleWhere(proposals.workspaceId, userId),
    // Mirror listCaptureRuns: the executor stamps `correlationId` on approval
    // and that is the id diagnose/getRun pass in. Match BOTH so a run is
    // resolvable by its correlationId, not just the proposal row id.
    lens.exactRunId
      ? or(
          eq(proposals.correlationId, lens.exactRunId),
          eq(proposals.id, lens.exactRunId)
        )
      : undefined,
    lens.workspaceId ? eq(proposals.workspaceId, lens.workspaceId) : undefined,
    lens.projectId ? eq(proposals.projectId, lens.projectId) : undefined,
    // SESSION lens (proposed path). `proposals.session_id` is stamped by
    // every capability door that forwards a session; `proposals_session_id_idx`
    // is the index it was created for.
    lens.sessionId ? eq(proposals.sessionId, lens.sessionId) : undefined
  )!;
}

/**
 * DIRECT runs: `capability_run` ai_decision events, USER-floored on
 * `events.userId`. Includes REFUSED attempts (`data.outcome = "refused"`) — the
 * caller decides whether a refusal is a row it shows.
 *
 * Has no `projectId` axis: events carry no project column, so a project-scoped
 * reader must skip this ledger itself (and say so), never pretend to filter it.
 */
export function capabilityRunEventWhere(
  userId: string,
  lens: Omit<CapabilityRunLens, "projectId"> = {}
): SQL {
  return and(
    eq(events.subjectType, AI_DECISION),
    drizzleSql`${events.data}->>'kind' = ${CAPABILITY_RUN_EVENT_KIND}`,
    // A direct run's identity IS its correlationId — required so it is
    // listable + diagnosable by that key.
    drizzleSql`${events.correlationId} IS NOT NULL`,
    eq(events.userId, userId),
    lens.exactRunId ? eq(events.correlationId, lens.exactRunId) : undefined,
    lens.workspaceId
      ? drizzleSql`${events.data}->>'workspaceId' = ${lens.workspaceId}`
      : undefined,
    // SESSION lens (direct path). `recordDirectCapabilityRun` rides
    // the `events.session_id` COLUMN (0241) — never a `data` field —
    // which is exactly what `idx_events_session_id` keys on. This is
    // the only way a direct run is attributable to a session at all:
    // it has no proposal row to carry one.
    lens.sessionId ? eq(events.sessionId, lens.sessionId) : undefined
  )!;
}

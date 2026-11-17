/**
 * A run that waits on its HUMAN STAGE GATE (`playbook.stage_gate`, filed by
 * `openStageGate` in @synap/api `services/playbooks/stage-gate.ts`, targeting
 * the session): what it means for the session's end.
 *
 *  - The ended-run sweep must not close it (`session-lifecycle-sweep.ts`): the
 *    gate is the person's decision, and approving it is what continues the
 *    run. Its playbook run reads `completed` once the agent's turn ended at
 *    the gate, so "every run ended" alone closed it (live, 9 Nov 2026: run
 *    be143ceb closed with its Draft gate 9c527c67 pending; the person
 *    approved it at 23:08 and nothing happened).
 *  - A session that DOES end (a person closes it, cancels it, it fails) takes
 *    its pending gates with it: they are EXPIRED, stamped why
 *    ({@link expirePendingStageGatesOfEndedSessions}), so no approval is left
 *    that could only lead nowhere. Gates a session left pending before that
 *    rule, or through a race with its end, are expired the same way by the
 *    6-hourly sweep ({@link expireOrphanedStageGates}).
 *
 * The types are `STAGE_GATE_PROPOSAL_TYPES` (@synap/playbooks), mirrored: this
 * package does not import playbooks. `awaited-gate-types.parity.test.ts`
 * (@synap/api) pins the mirror to the source.
 */
import { and, eq, inArray, sql as drizzleSql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { TERMINAL_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import type { db } from "../client-pg.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { proposals, ProposalStatus } from "../schema/proposals.js";
import {
  transitionProposal,
  type ProposalStatusWriter,
} from "./proposal-transition.js";

export const STAGE_GATE_PROPOSAL_TYPES_MIRROR = [
  "playbook.stage_gate",
] as const;

const GATE_TYPES_SQL = drizzleSql.raw(
  STAGE_GATE_PROPOSAL_TYPES_MIRROR.map((t) => `'${t}'`).join(", ")
);

/** SQL: a pending human stage gate targets the session `sessionId`. */
export function stageGatePendingIn(sessionId: AnyPgColumn | SQL): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM proposals sg
    WHERE sg.target_type = 'focus_session'
      AND sg.target_id = (${sessionId})::text
      AND sg.status = 'pending'
      AND sg.proposal_type IN (${GATE_TYPES_SQL})
  )`;
}

/**
 * Expire the pending stage gates of sessions that just ENDED (`endedAs`:
 * closed, failed or cancelled). EXPIRED, never rejected: nobody decided, the
 * moment passed (`ProposalStatus.EXPIRED`, not scored). Each row says why
 * (`expiredBy: "session_ended"`, `sessionEndedAs`). Returns their ids.
 */
export async function expirePendingStageGatesOfEndedSessions(
  executor: ProposalStatusWriter,
  input: { sessionIds: readonly string[]; endedAs: string }
): Promise<string[]> {
  if (input.sessionIds.length === 0) return [];
  const rows = await transitionProposal(executor, {
    to: ProposalStatus.EXPIRED,
    from: [ProposalStatus.PENDING],
    set: {
      updatedAt: drizzleSql`now()`,
      data: drizzleSql`COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object(
             'expiredBy', 'session_ended',
             'sessionEndedAs', ${input.endedAs}::text)`,
    },
    where: and(
      eq(proposals.targetType, "focus_session"),
      inArray(proposals.targetId, [...input.sessionIds]),
      inArray(proposals.proposalType, [...STAGE_GATE_PROPOSAL_TYPES_MIRROR])
    ),
  }).returning({ id: proposals.id });
  return rows.map((r) => r.id);
}

/**
 * Expire the pending stage gates whose session has ALREADY ended. The backstop
 * of {@link expirePendingStageGatesOfEndedSessions}: that one runs when a
 * session ends, so a gate left pending before it existed (or by a race with
 * the end) stays approvable, and its approval can only fail ("This run ended
 * (closed) before its stage gate was answered", playbook-stage-gate.ts).
 * Live, 16 Nov 2026: three gates of runs closed on 9 Nov were approved and
 * failed; gate 491def0c on closed session 432f5ac2 was still pending.
 * Terminal = `TERMINAL_SESSION_STATUSES`, the rule the approval refuses on;
 * a paused, stale or active session keeps its gates. Returns the ids expired.
 */
export async function expireOrphanedStageGates(
  executor: Pick<typeof db, "selectDistinct" | "update">
): Promise<string[]> {
  const orphans = await executor
    .selectDistinct({
      sessionId: focusSessions.id,
      status: focusSessions.status,
    })
    .from(proposals)
    .innerJoin(
      focusSessions,
      eq(drizzleSql`${focusSessions.id}::text`, proposals.targetId)
    )
    .where(
      and(
        eq(proposals.targetType, "focus_session"),
        eq(proposals.status, ProposalStatus.PENDING),
        inArray(proposals.proposalType, [...STAGE_GATE_PROPOSAL_TYPES_MIRROR]),
        inArray(focusSessions.status, [...TERMINAL_SESSION_STATUSES])
      )
    );
  const byStatus = new Map<string, string[]>();
  for (const o of orphans) {
    byStatus.set(o.status, [...(byStatus.get(o.status) ?? []), o.sessionId]);
  }
  const expired: string[] = [];
  for (const [endedAs, sessionIds] of byStatus) {
    expired.push(
      ...(await expirePendingStageGatesOfEndedSessions(executor, {
        sessionIds,
        endedAs,
      }))
    );
  }
  return expired;
}

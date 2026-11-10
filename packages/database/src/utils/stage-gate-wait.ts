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
 *    that could only lead nowhere.
 *
 * The types are `STAGE_GATE_PROPOSAL_TYPES` (@synap/playbooks), mirrored: this
 * package does not import playbooks. `awaited-gate-types.parity.test.ts`
 * (@synap/api) pins the mirror to the source.
 */
import { and, eq, inArray, sql as drizzleSql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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

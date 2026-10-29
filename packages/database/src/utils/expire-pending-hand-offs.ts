/**
 * An agent that is ON a session leaves every pending hand-off of it to that
 * session stale (ticket 5de7efaa).
 *
 * MEASURED DEFECT (live, 2026-10-23): proposal 98c943af — an agent's
 * `focus_session/assign_agent` — stayed `pending` after the person put the
 * same agent on the session themselves. A person's (or an agent's own)
 * `addAgentId` applies directly, so nothing ever settled the hand-off, and the
 * review queue kept asking for a decision already made.
 *
 * So when an agent is attached by ANY door (`attachSessionAgent`, the one
 * roster door), the pending hand-offs of that (session, agent) pair are
 * EXPIRED, never rejected or approved: `ProposalStatus.EXPIRED` is "never
 * decided, its moment passed" and is not scored. Each row is stamped with what
 * superseded it. Precedents: `expirePendingCreatesOfLandedRecord`,
 * `expireProposalsStaleAfterMove`.
 *
 * Never the hand-off being approved right now (`landedByProposalId`): its own
 * executor attaches the agent while it is still pending.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../client-pg.js";
import { transitionProposal } from "./proposal-transition.js";
import { proposals, ProposalStatus } from "../schema/proposals.js";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Expire the pending hand-offs of an agent already on the session; their ids. */
export async function expirePendingHandOffsOfAttachedAgent(
  input: {
    sessionId: string;
    agentId: string;
    /** The hand-off proposal that attached the agent, when one did. */
    landedByProposalId?: string | null;
  },
  executor: typeof db | DbTx = db
): Promise<string[]> {
  const expired = await transitionProposal(executor, {
    to: ProposalStatus.EXPIRED,
    set: {
      updatedAt: new Date(),
      data: sql`COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object(
        'expiredBy', 'agent_attached',
        'supersededByProposalId', ${input.landedByProposalId ?? null}::text)`,
    },
    where: and(
      eq(proposals.status, ProposalStatus.PENDING),
      eq(proposals.targetType, "focus_session"),
      eq(proposals.proposalType, "assign_agent"),
      eq(proposals.targetId, input.sessionId),
      sql`${proposals.data}->'data'->>'addAgentId' = ${input.agentId}`,
      ...(input.landedByProposalId
        ? [ne(proposals.id, input.landedByProposalId)]
        : [])
    ),
  }).returning({ id: proposals.id });
  return expired.map((row) => row.id);
}

/**
 * A PERSON's move leaves pending agent proposals on that thing stale (work
 * model L2; review backend F16). An agent's `entity/transition` proposal
 * carries the status it believed (`expectedFrom`); once a person moves the
 * thing elsewhere, approving it could only fail the replay's compare-and-set.
 * Left pending, it still counts toward a worker's `maxPendingApprovals` and can
 * trip its approvals backlog for a thing a person already decided.
 *
 * So the human move EXPIRES them (`ProposalStatus.EXPIRED`: never decided, its
 * moment passed — not scored), stamping which transition superseded them. Same
 * lifecycle only (the kind's, or the same facet's); a proposal that expects
 * the status the person just chose stays answerable.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema/index.js";
import type { StatusTransition } from "./apply-status-move.js";
import { proposals, ProposalStatus } from "../../schema/proposals.js";
import {
  transitionProposal,
  type ProposalStatusWriter,
} from "../../utils/proposal-transition.js";

type Db = PostgresJsDatabase<typeof schema>;

/** Expire the agent transition proposals a person's move made stale; their ids. */
export async function expireProposalsStaleAfterMove(
  db: Db,
  transition: Pick<
    StatusTransition,
    "transitionId" | "entityId" | "facetId" | "to" | "actorKind"
  >
): Promise<string[]> {
  if (transition.actorKind !== "human") return [];
  // Through the status door (`transitionProposal`): pending → expired is in
  // the transition table, and the door adds that guard to this predicate.
  const rows = await transitionProposal(db as unknown as ProposalStatusWriter, {
    to: ProposalStatus.EXPIRED,
    from: [ProposalStatus.PENDING],
    set: {
      updatedAt: sql`now()`,
      data: sql`COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object(
             'expiredBy', 'lifecycle_move',
             'supersededByTransitionId', ${transition.transitionId}::text)`,
    },
    where: and(
      eq(proposals.targetType, "entity"),
      eq(proposals.proposalType, "transition"),
      eq(proposals.targetId, transition.entityId),
      isNotNull(proposals.agentUserId),
      sql`COALESCE(${proposals.data}->'data'->>'facetId', ${proposals.data}->>'facetId', '')
           = COALESCE(${transition.facetId}::text, '')`,
      sql`COALESCE(${proposals.data}->'data'->>'expectedFrom', ${proposals.data}->>'expectedFrom')
           IS DISTINCT FROM ${transition.to}`
    ),
  }).returning({ id: proposals.id });
  return rows.map((r) => r.id);
}

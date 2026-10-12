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
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema/index.js";
import type { StatusTransition } from "./apply-status-move.js";

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
  const res = await db.execute(sql`
    UPDATE proposals
       SET status = 'expired',
           updated_at = now(),
           data = COALESCE(data, '{}'::jsonb) || jsonb_build_object(
             'expiredBy', 'lifecycle_move',
             'supersededByTransitionId', ${transition.transitionId}::text)
     WHERE status = 'pending'
       AND target_type = 'entity'
       AND proposal_type = 'transition'
       AND target_id = ${transition.entityId}
       AND agent_user_id IS NOT NULL
       AND COALESCE(data->'data'->>'facetId', data->>'facetId', '')
           = COALESCE(${transition.facetId}::text, '')
       AND COALESCE(data->'data'->>'expectedFrom', data->>'expectedFrom')
           IS DISTINCT FROM ${transition.to}
    RETURNING id`);
  // postgres.js returns the rows; the PGlite driver (tests) wraps them.
  const rows = (
    Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])
  ) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

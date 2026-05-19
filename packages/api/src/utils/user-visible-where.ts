/**
 * `userVisibleWhere` — single source of truth for "what workspaces can this
 * user see" in pod↔outside boundary procedures.
 *
 * Background:
 *   Workspaces are lenses, not silos. When a UI surface above the workspace
 *   level (Eve OS, cross-workspace search, dashboards, AI agents that span
 *   contexts) asks the pod for data, the filter MUST be by USER, not by
 *   workspace. This helper expresses that as a Drizzle WHERE predicate:
 *
 *     "rows where workspaceId IS NULL (pod-wide globals) OR workspaceId
 *      belongs to a workspace the user is a member of"
 *
 * Pair this with a `.listAll` procedure variant alongside each
 * workspace-scoped `.list`. The convention across the pod's tRPC surface:
 *
 *   entities.list      / entities.listAll
 *   proposals.list     / proposals.listAll
 *   notifCenter.list   / notifCenter.listAll
 *   graph.getStats     / graph.getStatsAll
 *
 * Eve OS calls the `.listAll` variant via its scope-aware `usePodQuery`
 * helper; Studio keeps using `.list` because it always has an active
 * workspace. Both speak to the same pod tRPC surface.
 */

import { eq, inArray, isNull, or } from "@synap/database";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@synap/database";
import { workspaceMembers } from "@synap/database/schema";

/**
 * Returns a Drizzle predicate matching rows visible to `userId`:
 *   - rows where `workspaceIdColumn IS NULL` (pod-wide globals), OR
 *   - rows whose `workspaceId` is in any workspace the user is a member of.
 *
 * The subquery is correlated at the database level — Postgres can optimise
 * it as a semi-join, so one round-trip serves arbitrarily many workspaces
 * without an N+1 fan-out on the client.
 *
 * Compose with other conditions via `and(...)`:
 *
 *   const conditions = [
 *     isNull(entities.deletedAt),
 *     userVisibleWhere(entities.workspaceId, ctx.userId),
 *   ];
 *   const rows = await db.query.entities.findMany({ where: and(...conditions) });
 */
export function userVisibleWhere(
  workspaceIdColumn: AnyPgColumn,
  userId: string
): SQL {
  const userWorkspaceIds = db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));

  // The non-null assertion is safe: `or` of two non-null operands is non-null.
  return or(
    isNull(workspaceIdColumn),
    inArray(workspaceIdColumn, userWorkspaceIds)
  )!;
}

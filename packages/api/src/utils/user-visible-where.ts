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

import { eq, inArray, isNull, or, drizzleSql } from "@synap/database";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@synap/database";
import { workspaceMembers, workspaces } from "@synap/database/schema";

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
  // A user can see a row's workspace if they are a MEMBER of it, they OWN it
  // (ownerId is a first-class column, SEPARATE from workspace_members — a
  // sovereign/single-user pod's owner may not have a member row, so membership
  // alone would hide their own data), or it is POD-VISIBLE (readable pod-wide by
  // design). This mirrors getUserAccessibleWorkspaceIds so reads are consistent.
  const memberWs = db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const ownedWs = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.ownerId, userId));
  const podVisibleWs = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      drizzleSql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible','pod_joinable')`
    );

  // `proposals.workspace_id` is TEXT while `workspaces.id` /
  // `workspace_members.workspace_id` are UUID — cast the column to uuid so the
  // IN comparison matches. This is a no-op for the already-uuid columns this
  // helper is also used on (entities/views/channels/automations); every stored
  // value is a valid uuid.
  const col = drizzleSql`${workspaceIdColumn}::uuid`;
  // `or(...)` of non-null operands is non-null.
  return or(
    isNull(workspaceIdColumn),
    inArray(col, memberWs),
    inArray(col, ownedWs),
    inArray(col, podVisibleWs)
  )!;
}

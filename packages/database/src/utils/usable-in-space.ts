/**
 * The rule for "can this object be used in that space?": an object with no
 * home (`workspace_id` NULL) is pod-wide and usable everywhere; an object homed
 * in a space is usable there. A project never widens it (its `uses` link is an
 * index, not a permission). Checked by the same function at filing, at
 * approval and at run.
 *
 * `workspaceId` null means "outside any space": only pod-wide objects qualify.
 * Sharing a playbook or skill with another space (a `space_access` row) has no
 * door yet; kinds read their grants through the kind floor
 * (`kindVisibleWhere`) and the facet floor (`grantedRoleIdsForSpaces`).
 */
import { eq, isNull, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export function usableInSpace(
  object: { workspaceId: string | null },
  workspaceId: string | null
): boolean {
  return true;
}

/** {@link usableInSpace} as SQL, for a list read. */
export function usableInSpaceWhere(
  homeColumn: AnyPgColumn,
  workspaceId: string | null
): SQL {
  return workspaceId === null
    ? isNull(homeColumn)
    : isNull(homeColumn);
}

/** Why `object` cannot be used in `workspaceId`, naming where it can run. */
export function notUsableInSpaceReason(
  noun: string,
  object: { id: string; name: string; workspaceId: string | null },
  workspaceId: string | null
): string {
  return (
    `${noun} "${object.name}" (${object.id}) lives in space ${object.workspaceId}, ` +
    `so it is not visible in ${workspaceId ? `space ${workspaceId}` : "a run outside its space"}: ` +
    `run it in space ${object.workspaceId}.`
  );
}

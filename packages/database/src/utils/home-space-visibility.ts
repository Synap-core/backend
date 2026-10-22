/**
 * HOME-SPACE VISIBILITY (founder decision 2026-10-22, pod issue 2a743336).
 *
 * A pod-scope kind (decision, knowledge, person, …) is filed pod-wide
 * (`workspace_id` NULL) even when written from a space — placement decisions
 * D1 / FX-B1 / D14, "pin ≠ exclusive". The owner floor then hid it from
 * everyone but its author, so a decision filed for a team was invisible to the
 * team, and a team document embedding it showed them a locked embed.
 *
 * The create doors now record the space the write came from in
 * `entities.home_workspace_id` (`resolveEntityHomeWorkspaceId`,
 * services/workspace-resolution-service.ts). These two builders are THE
 * predicate that turns it into read access for that space's MEMBERS (a
 * `workspace_members` row, or the space's owner — the same "belongs to" as
 * `grantedRoleIdsFor`). Composed by:
 *   - `accessScopeWhere` (packages/api utils/project-scope.ts) — the entity
 *     floor + workspace lens, and the document floor (a document follows its
 *     entity);
 *   - `entityQueryVisibilityWhere` (packages/jobs workers/entity-query-scope.ts).
 *
 * NARROW BY CONSTRUCTION, like `podSharedFacetWhere`:
 *   - pod-wide rows only (`workspace_id IS NULL`) — it can never admit a
 *     workspace row, so no workspace data is widened;
 *   - a row with no home matches nothing (`NULL IN (…)` is not TRUE), so an
 *     un-homed pod-wide entity stays owner-only;
 *   - it binds the CALLER's id only, never a row owner;
 *   - a caller in no space (a portal guest, by definition — `podGuestWhere`)
 *     matches nothing.
 *
 * READ ONLY. The entity WRITE floor (`entityWriteVisibleWhere`) and the
 * dedup / mutation existence gates never compose it: widening what a member
 * can SEE never widens what they can TARGET.
 */

import { type SQL, and, inArray, isNull, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { memberWorkspaceIds, ownedWorkspaceIds } from "./user-visible-where.js";

/** `homeColumn` names a space `userId` belongs to (member or owner). */
function homeInCallerSpaces(homeColumn: AnyPgColumn, userId: string): SQL {
  return or(
    inArray(homeColumn, memberWorkspaceIds(userId)),
    inArray(homeColumn, ownedWorkspaceIds(userId))
  )!;
}

/**
 * FLOOR BRANCH — a pod-wide row homed in a space `userId` belongs to.
 */
export function homeSpaceSharedWhere(
  workspaceIdColumn: AnyPgColumn,
  homeWorkspaceIdColumn: AnyPgColumn,
  userId: string
): SQL {
  return and(
    isNull(workspaceIdColumn),
    homeInCallerSpaces(homeWorkspaceIdColumn, userId)
  )!;
}

/**
 * LENS COMPANION — a pod-wide row homed in one of the LENS space(s), so that
 * space's lists show what was filed for it. SELF-GATING (the
 * `facetInWorkspaceLensWhere` rule): the caller must belong to the home space
 * itself, so a forged lens id for a space they are not in surfaces nothing.
 */
export function homeSpaceInLensWhere(
  workspaceIdColumn: AnyPgColumn,
  homeWorkspaceIdColumn: AnyPgColumn,
  userId: string,
  lens: string | string[]
): SQL {
  const ids = Array.isArray(lens) ? lens : [lens];
  return and(
    isNull(workspaceIdColumn),
    inArray(homeWorkspaceIdColumn, ids),
    homeInCallerSpaces(homeWorkspaceIdColumn, userId)
  )!;
}

/**
 * THE project visibility predicate for the access layer — ONE function, used by
 * the `projects` VisibilityRule AND by every table whose rows are exactly as
 * visible as their parent project (today: `project_tracks`).
 *
 * Workspace-scoped projects follow workspace membership (narrowed by the
 * caller's lens); a pod-personal project (NULL workspace) keeps an OWNER floor.
 * See the `projects` registration in `registry.ts` for why this is not
 * `workspaceOwned`.
 *
 * MEMBER BRANCH (Sites W2): a caller holding ANY `project_members` row on a
 * project (guest included) sees that project — and, through `project_tracks`,
 * its tracks — even without workspace access. The workspace lens still only
 * narrows it (`lensMatchOnly`), so a focused workspace W never surfaces a
 * project filed in workspace X.
 */

import { projects } from "@synap/database/schema";
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { AccessContext, Lens } from "./context.js";
import { workspaceLensWhere } from "../utils/user-visible-where.js";
import { projectMembershipWhere } from "../utils/project-scope.js";

/**
 * The workspace LENS alone, as a pure narrowing of a member branch (no floor —
 * the member branch IS the floor there): `undefined`/`[]` = no narrowing,
 * `null` = NULL-workspace rows only, `"<id>"` = that workspace, `string[]` = that
 * set. Mirrors the three lens states of `workspaceLensWhere`.
 */
export function lensMatchOnly(
  column: AnyPgColumn,
  lens: Lens
): SQL | undefined {
  if (lens === undefined) return undefined;
  if (lens === null) return isNull(column);
  if (Array.isArray(lens)) {
    return lens.length === 0 ? undefined : inArray(column, lens);
  }
  return eq(column, lens);
}

/** Projects the caller is a member of (any role), narrowed by the lens. */
export function projectMemberBranch(userId: string, lens: Lens): SQL {
  return and(
    projectMembershipWhere(projects.id, userId),
    lensMatchOnly(projects.workspaceId, lens)
  )!;
}

export function projectVisibleWhere(access: AccessContext): SQL | undefined {
  return or(
    and(
      isNotNull(projects.workspaceId),
      workspaceLensWhere(
        projects.workspaceId,
        access.userId,
        access.workspaceLens
      )
    ),
    and(isNull(projects.workspaceId), eq(projects.userId, access.userId)),
    projectMemberBranch(access.userId, access.workspaceLens)
  );
}

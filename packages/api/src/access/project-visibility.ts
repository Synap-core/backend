/**
 * THE project visibility predicate for the access layer — ONE function, used by
 * the `projects` VisibilityRule AND by every table whose rows are exactly as
 * visible as their parent project (today: `project_tracks`).
 *
 * Workspace-scoped projects follow workspace membership (narrowed by the
 * caller's lens); a pod-personal project (NULL workspace) keeps an OWNER floor.
 * See the `projects` registration in `registry.ts` for why this is not
 * `workspaceOwned`.
 */

import { projects } from "@synap/database/schema";
import { and, eq, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import type { AccessContext } from "./context.js";
import { workspaceLensWhere } from "../utils/user-visible-where.js";

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
    and(isNull(projects.workspaceId), eq(projects.userId, access.userId))
  );
}

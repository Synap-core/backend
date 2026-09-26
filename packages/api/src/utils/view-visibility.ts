/**
 * THE view read predicate — ONE definition, replacing the copies that lived in
 * the `views` VisibilityRule (access/registry.ts), `routers/views.ts`
 * (`viewVisibleWhere`) and `routers/resource-state.ts` (`viewVisibleWhere`).
 *
 * Three branches:
 *   1. workspace view → workspace membership, narrowed by the lens;
 *   2. pod-personal view (NULL workspace) → its owner;
 *   3. EXPOSED view (Sites W2) → any member (guest included) of the project the
 *      view is exposed to: `exposed_at IS NOT NULL` AND `project_id` is one of
 *      the caller's projects.
 *
 * `project_id` alone is NOT exposure: since 0166 a view with `project_id` set and
 * `exposed_at` NULL is a surface PINNED to a project, visible exactly as before.
 * Only the explicit `exposed_at` marker (0276, with a CHECK that it implies
 * `project_id`) shares a view. Exposure grants READ only — `assertViewAccess`
 * never admits a write through it.
 */

import { and, eq, isNotNull, isNull, or } from "@synap/database";
import type { SQL } from "drizzle-orm";
import { views } from "@synap/database/schema";
import { workspaceLensWhere } from "./user-visible-where.js";
import { projectMembershipWhere } from "./project-scope.js";
import { lensMatchOnly } from "../access/project-visibility.js";
import type { Lens } from "../access/context.js";

/** Branch 3: views exposed to a project the caller is a member of. */
export function exposedViewMemberWhere(userId: string, lens: Lens): SQL {
  return and(
    isNotNull(views.exposedAt),
    isNotNull(views.projectId),
    projectMembershipWhere(views.projectId, userId),
    lensMatchOnly(views.workspaceId, lens)
  )!;
}

/** All three branches: every view `userId` may read under `lens`. */
export function viewReadableWhere(userId: string, lens: Lens): SQL {
  return or(
    and(
      isNotNull(views.workspaceId),
      workspaceLensWhere(views.workspaceId, userId, lens)
    ),
    and(isNull(views.workspaceId), eq(views.userId, userId)),
    exposedViewMemberWhere(userId, lens)
  )!;
}

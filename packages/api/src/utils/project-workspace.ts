/**
 * Project --uses--> workspace — the FOUNDING INDEX of which domains an
 * engagement runs through.
 *
 * ONE write door: `linkProjectToWorkspace`. Inserts through `createLink` (the
 * existing links-service unique-edge path, `onConflictDoNothing`). NOT an ACL:
 * this never writes `workspace_members` / `project_members`. Entity membership
 * stays `belongs_to_project` on the relations table (`linkEntityToProject`).
 *
 * Distinct from live `used` (session --used--> tool, run provenance).
 *
 * Readers reuse the same `links` graph `getLinksFor` already walks. The typed
 * `eq(links.linkType, "uses")` query is the batch door `projects.list` needs
 * (not N+1) and the shape the LinkType SSOT tripwire derives live types from.
 */

import {
  and,
  eq,
  inArray,
  getDb,
  links,
  projects,
  workspaces,
  ownerPrivateVisibleWhere,
  userVisibleWhere,
  drizzleSql,
} from "@synap/database";

/** INDEX projection a UI/agent can name, not just id. */
export type UsedWorkspaceRef = {
  id: string;
  name: string;
  domain: string | null;
};

/**
 * Hydrate uses-edge ids to {id, name, domain}. Order of `ids` is preserved.
 * Missing rows are omitted — a deleted workspace, same as a workspace the
 * viewer is not a member/owner of and that isn't pod-visible (floored with
 * `userVisibleWhere(workspaces.id, userId)`, the same predicate
 * `workspaces.list` / `diagnose` use). The `uses` edge is an INDEX, not an
 * ACL, but the workspace's NAME/DOMAIN are still that workspace's own data —
 * a project viewer who isn't in the used workspace must not see them.
 */
export async function hydrateUsedWorkspaces(
  db: Awaited<ReturnType<typeof getDb>>,
  ids: readonly string[],
  userId: string
): Promise<UsedWorkspaceRef[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      domain: workspaces.domain,
    })
    .from(workspaces)
    .where(
      and(
        inArray(workspaces.id, [...ids]),
        userVisibleWhere(workspaces.id, userId)
      )
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: UsedWorkspaceRef[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}
import { createLink } from "../services/links/links-service.js";

export type LinkProjectToWorkspaceResult =
  | { linked: true }
  | { linked: false; reason: "project_not_found" | "workspace_not_found" };

/**
 * Stamp `project --uses--> workspace`. The project is a row in the `projects`
 * TABLE. Safe to call repeatedly — the unique edge index dedupes.
 *
 * Verifies the project exists and is visible to `userId` first (same
 * `ownerPrivateVisibleWhere` floor `linkEntityToProject` uses) so a stale or
 * foreign project id cannot write a ghost INDEX edge. Does NOT consult
 * workspace membership — this is an index, not an ACL.
 */
export async function linkProjectToWorkspace(
  db: Awaited<ReturnType<typeof getDb>>,
  args: {
    projectId: string;
    workspaceId: string;
    userId: string;
  }
): Promise<LinkProjectToWorkspaceResult> {
  const [visible] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, args.projectId),
        ownerPrivateVisibleWhere(
          projects.workspaceId,
          projects.userId,
          args.userId
        )
      )
    )
    .limit(1);

  if (!visible) {
    return { linked: false, reason: "project_not_found" };
  }

  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, args.workspaceId))
    .limit(1);
  if (!workspace) {
    return { linked: false, reason: "workspace_not_found" };
  }

  await createLink({
    workspaceId: args.workspaceId,
    fromType: "project",
    fromId: args.projectId,
    toType: "workspace",
    toId: args.workspaceId,
    linkType: "uses",
  });
  return { linked: true };
}

export type UnlinkProjectFromWorkspaceResult =
  | { unlinked: true; rows: number }
  | { unlinked: false; reason: "project_not_found" };

/**
 * Remove `project --uses--> workspace` — the inverse of
 * `linkProjectToWorkspace`, and the ONE door for it. Callers govern first
 * (MCP `synap_project_use_workspace {remove:true}` files `link/delete` through
 * `checkPermissionOrPropose`; the `link/delete` approval executor replays here).
 *
 * Same floor as the add: the project must exist and be visible to `userId`
 * (`ownerPrivateVisibleWhere`). The workspace is NOT looked up — an edge to an
 * archived or deleted workspace must stay removable, that is the main reason
 * this door exists. Deletes ONLY the `uses` edge of that exact pair; `rows` is
 * the DELETE's own RETURNING count (`0` = there was no such edge).
 */
export async function unlinkProjectFromWorkspace(
  db: Awaited<ReturnType<typeof getDb>>,
  args: {
    projectId: string;
    workspaceId: string;
    userId: string;
  }
): Promise<UnlinkProjectFromWorkspaceResult> {
  const [visible] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, args.projectId),
        ownerPrivateVisibleWhere(
          projects.workspaceId,
          projects.userId,
          args.userId
        )
      )
    )
    .limit(1);
  if (!visible) {
    return { unlinked: false, reason: "project_not_found" };
  }

  const removed = await db
    .delete(links)
    .where(
      and(
        eq(links.fromType, "project"),
        eq(links.fromId, args.projectId),
        eq(links.toType, "workspace"),
        eq(links.toId, args.workspaceId),
        eq(links.linkType, "uses")
      )
    )
    .returning({ id: links.id });
  return { unlinked: true, rows: removed.length };
}

/**
 * Workspace ids a project uses. Same unscoped INDEX query as the batch door —
 * membership is NOT applied here (INDEX ≠ ACL). `userId` is kept so callers
 * that already authenticated a project read don't have to change signature.
 */
export async function listWorkspacesUsedByProject(
  userId: string,
  projectId: string
): Promise<string[]> {
  const db = await getDb();
  const map = await listWorkspacesUsedByProjects(db, [projectId], userId);
  return map.get(projectId) ?? [];
}

/**
 * Batch: workspace ids each project uses. Typed `eq(links.linkType, "uses")`
 * so `projects.list` is one query, not N `getLinksFor` calls.
 *
 * Floored to workspaces `userId` can see (`userVisibleWhere(workspaces.id,
 * userId)`, the same predicate `workspaces.list` / `diagnose` use) via a JOIN
 * — a used workspace the viewer isn't a member/owner of, and that isn't
 * pod-visible, is omitted, not exposed. The `uses` edge is an INDEX, not an
 * ACL; this floor is about what NAME/rows the viewer is shown, not about
 * granting or denying access to the edge itself.
 */
export async function listWorkspacesUsedByProjects(
  db: Awaited<ReturnType<typeof getDb>>,
  projectIds: string[],
  userId: string
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (projectIds.length === 0) return result;

  const rows = await db
    .select({ fromId: links.fromId, toId: links.toId })
    .from(links)
    // `workspaces.id` is uuid, `links.to_id` is text (polymorphic): cast the
    // uuid side, same pattern as `listProjectsUsingWorkspace`'s join below.
    .innerJoin(workspaces, eq(drizzleSql`${workspaces.id}::text`, links.toId))
    .where(
      and(
        eq(links.fromType, "project"),
        inArray(links.fromId, projectIds),
        eq(links.toType, "workspace"),
        eq(links.linkType, "uses"),
        userVisibleWhere(workspaces.id, userId)
      )
    );

  for (const row of rows) {
    const current = result.get(row.fromId);
    if (current) {
      if (!current.includes(row.toId)) current.push(row.toId);
    } else {
      result.set(row.fromId, [row.toId]);
    }
  }
  return result;
}

/**
 * Reverse: project ids that use this workspace. Same typed uses-edge, other
 * direction — "which projects run through this domain?"
 *
 * Floors on `ownerPrivateVisibleWhere` so a caller never learns about a
 * project they cannot see. NOT an ACL on the workspace — only the INDEX
 * projection is filtered. Failed visibility ≠ "no projects use this".
 */
export async function listProjectsUsingWorkspace(
  db: Awaited<ReturnType<typeof getDb>>,
  workspaceId: string,
  userId: string
): Promise<string[]> {
  const rows = await db
    .select({ fromId: links.fromId })
    .from(links)
    // `projects.id` is uuid, `links.from_id` is text (polymorphic): a bare
    // column join is PG 42883 and fails EVERY call. Cast the uuid side.
    .innerJoin(projects, eq(drizzleSql`${projects.id}::text`, links.fromId))
    .where(
      and(
        eq(links.fromType, "project"),
        eq(links.toType, "workspace"),
        eq(links.toId, workspaceId),
        eq(links.linkType, "uses"),
        ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId)
      )
    );
  return [...new Set(rows.map((r) => r.fromId))];
}

/**
 * Batch reverse: project ids using each workspace, floored to what `userId`
 * can see. One JOIN for `workspaces.list` / Hub GET /workspaces — not N+1.
 */
export async function listProjectsUsingWorkspaces(
  db: Awaited<ReturnType<typeof getDb>>,
  workspaceIds: string[],
  userId: string
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (workspaceIds.length === 0) return result;

  const rows = await db
    .select({ workspaceId: links.toId, projectId: links.fromId })
    .from(links)
    // `projects.id` is uuid, `links.from_id` is text (polymorphic): a bare
    // column join is PG 42883 and fails EVERY call. Cast the uuid side.
    .innerJoin(projects, eq(drizzleSql`${projects.id}::text`, links.fromId))
    .where(
      and(
        eq(links.fromType, "project"),
        eq(links.toType, "workspace"),
        inArray(links.toId, workspaceIds),
        eq(links.linkType, "uses"),
        ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId)
      )
    );

  for (const row of rows) {
    const current = result.get(row.workspaceId);
    if (current) {
      if (!current.includes(row.projectId)) current.push(row.projectId);
    } else {
      result.set(row.workspaceId, [row.projectId]);
    }
  }
  return result;
}

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
  ownerPrivateVisibleWhere,
} from "@synap/database";
import { createLink, getLinksFor } from "../services/links/links-service.js";

export type LinkProjectToWorkspaceResult =
  { linked: true } | { linked: false; reason: "project_not_found" };

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

/**
 * Workspace ids a project uses, via the canonical `getLinksFor` neighbour
 * read (same graph Hub GET /links walks). Filters to the uses-edge; other
 * project neighbours (subject, instantiated_from, …) are ignored.
 */
export async function listWorkspacesUsedByProject(
  userId: string,
  projectId: string
): Promise<string[]> {
  const edges = await getLinksFor(userId, "project", projectId);
  return [
    ...new Set(
      edges
        .filter(
          (e) =>
            e.fromType === "project" &&
            e.fromId === projectId &&
            e.toType === "workspace" &&
            e.linkType === "uses"
        )
        .map((e) => e.toId)
    ),
  ];
}

/**
 * Batch: workspace ids each project uses. Typed `eq(links.linkType, "uses")`
 * so `projects.list` is one query, not N `getLinksFor` calls.
 */
export async function listWorkspacesUsedByProjects(
  db: Awaited<ReturnType<typeof getDb>>,
  projectIds: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (projectIds.length === 0) return result;

  const rows = await db
    .select({ fromId: links.fromId, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "project"),
        inArray(links.fromId, projectIds),
        eq(links.toType, "workspace"),
        eq(links.linkType, "uses")
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
 */
export async function listProjectsUsingWorkspace(
  db: Awaited<ReturnType<typeof getDb>>,
  workspaceId: string
): Promise<string[]> {
  const rows = await db
    .select({ fromId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "project"),
        eq(links.toType, "workspace"),
        eq(links.toId, workspaceId),
        eq(links.linkType, "uses")
      )
    );
  return [...new Set(rows.map((r) => r.fromId))];
}

/**
 * D6 — change a project's HOME workspace. Shared by the two update doors
 * (tRPC `projects.update`, Hub `PATCH /projects/:id` → MCP `update_project`
 * goes through the tRPC one) so their target checks can never disagree.
 *
 * The move itself is governed by the doors' own `checkPermissionOrPropose`
 * (gate on the project's CURRENT workspace, like every project update). This
 * adds the half that gate cannot see: the caller must be able to WRITE the
 * target. It runs BEFORE the gate, so an agent cannot file a proposal into a
 * workspace its user cannot write, and again on the approval replay.
 */

import { TRPCError } from "@trpc/server";
import { eq, workspaces, type getDb } from "@synap/database";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { linkProjectToWorkspace } from "../../utils/project-workspace.js";

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * The effective new home, or `undefined` when nothing moves (omitted, or the
 * same workspace — never a proposal of nothing). Throws NOT_FOUND for an
 * unknown / archived target, FORBIDDEN when the caller cannot write it.
 */
export async function resolveProjectHomeChange(
  db: Db,
  userId: string,
  currentWorkspaceId: string | null,
  requested: string | undefined
): Promise<string | undefined> {
  if (requested === undefined || requested === currentWorkspaceId) {
    return undefined;
  }
  const [home] = await db
    .select({
      id: workspaces.id,
      ownerId: workspaces.ownerId,
      archivedAt: workspaces.archivedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, requested))
    .limit(1);
  if (!home || home.archivedAt) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Target home workspace not found",
    });
  }
  await assertWorkspaceWrite(db, userId, {
    workspaceId: home.id,
    ownerId: home.ownerId,
  });
  return home.id;
}

/**
 * After the write: the new home is a domain the engagement runs through, so
 * stamp the `uses` INDEX edge. Existing edges (incl. the old home's) stay.
 */
export async function stampProjectHomeUse(
  db: Db,
  args: { projectId: string; homeWorkspaceId: string; userId: string }
): Promise<void> {
  await linkProjectToWorkspace(db, {
    projectId: args.projectId,
    workspaceId: args.homeWorkspaceId,
    userId: args.userId,
  });
}

/**
 * assertWorkspaceWrite — the canonical gate for a mutation on a workspace-scoped
 * row.
 *
 * THE RULE: always gate against the ROW's `workspaceId` (loaded from the DB),
 * NEVER a request-supplied `input.workspaceId` / `ctx.workspaceId`. Gating on a
 * caller-supplied workspace is the cross-workspace WRITE-leak class — the check
 * passes for a workspace the attacker belongs to while the write lands on a
 * different workspace's row (matched by id).
 *
 *   - workspace row  → caller must be an editor+ member of THAT workspace.
 *     With NO member row at all, its owner (`workspaces.owner_id`) writes: a
 *     missing member row is a data repair, not a permission (founder Q-A1,
 *     2026-10-26). A member row is the authority when there is one: an owner
 *     demoted to viewer does not write.
 *   - pod-wide row (workspaceId === null) with a known owner → caller must be
 *     the owner (pass `ownerId`).
 *   - pod-wide row with no owner → system-managed; denied here (use an
 *     admin-scoped path).
 *
 * This is the write-side companion to `userVisibleWhere` / the access layer's
 * read scoping. It is a *floor* (editor+ membership); routes that need finer
 * granularity (e.g. admin-only delete) keep their own `verifyPermission` /
 * `checkPermissionOrPropose` call — but that call must also key off the loaded
 * row's workspaceId, not the request's.
 */

import { TRPCError } from "@trpc/server";
import { eq, getWorkspaceMembership, workspaces } from "@synap/database";
import type { SQL } from "drizzle-orm";
// The write floor's role set is SHARED with the clients' space pickers
// (`@synap-core/types/workspaces`) — one rule, never a mirror (FX-F3).
import { isSpaceWriteRole } from "@synap-core/types/workspaces";

export async function assertWorkspaceWrite(
  db: unknown,
  userId: string | null | undefined,
  row: { workspaceId: string | null | undefined; ownerId?: string | null }
): Promise<void> {
  if (!userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }

  if (row.workspaceId) {
    const membership = await getWorkspaceMembership(
      db,
      row.workspaceId,
      userId
    );
    const allowed = membership
      ? isSpaceWriteRole(membership.role)
      : await ownsWorkspace(db, row.workspaceId, userId);
    if (!allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You are not a member of this resource's workspace.",
      });
    }
    return;
  }

  // Pod-wide row (no workspace): allow only the owner, if there is one.
  if (row.ownerId !== undefined) {
    if (row.ownerId !== userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only the owner can modify this pod-wide resource.",
      });
    }
    return;
  }

  throw new TRPCError({
    code: "FORBIDDEN",
    message: "This resource is system-managed and not editable here.",
  });
}

/** Read through the caller's `db` (a transaction stays one), as `getWorkspaceMembership`. */
interface WorkspaceOwnerReader {
  query: {
    workspaces: {
      findFirst(q: {
        where: SQL;
        columns: { ownerId: true };
      }): Promise<{ ownerId: string | null } | undefined>;
    };
  };
}

async function ownsWorkspace(
  db: unknown,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const ws = await (db as WorkspaceOwnerReader).query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { ownerId: true },
  });
  return ws?.ownerId === userId;
}

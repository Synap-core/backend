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
import { getWorkspaceMembership } from "@synap/database";

const WRITE_ROLES = new Set(["owner", "admin", "editor"]);

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
    if (!membership || !WRITE_ROLES.has(membership.role)) {
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

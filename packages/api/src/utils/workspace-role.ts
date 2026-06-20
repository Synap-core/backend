/**
 * Workspace-role helpers — the owner/admin gates shared by capability routers.
 *
 * Extracted from `routers/mcp-servers.ts` so the per-capability approval
 * mutations on `tools` and `skills` reuse the EXACT same gate (don't duplicate):
 *   - `getWorkspaceRole(userId, workspaceId)` → the caller's role in a workspace.
 *   - `requireAdminRole(role)` → throw unless owner|admin.
 *   - `requirePodAdmin(userId)` → throw unless owner|admin of the `pod-admin`
 *     system workspace (the gate for pod-wide / null-workspace rows).
 */

import { TRPCError } from "@trpc/server";
import { db, eq, and, inArray } from "@synap/database";
import { workspaceMembers, workspaces } from "@synap/database/schema";

/** The caller's role in a workspace, or undefined if not a member. */
export async function getWorkspaceRole(userId: string, workspaceId: string) {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { role: true },
  });
  return membership?.role;
}

/** Require owner or admin role — throws FORBIDDEN otherwise. */
export function requireAdminRole(role: string | undefined | null) {
  if (!["owner", "admin"].includes(role ?? "")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only workspace owners and admins can perform this action.",
    });
  }
}

/**
 * Require pod-admin (owner/admin of the `pod-admin` system workspace) for
 * pod-wide (null-workspace) rows. A pod-wide capability is visible to every
 * workspace, so creating/approving one is a pod-level privileged action —
 * mirrors `podAdminProcedure` in trpc.ts. Throws FORBIDDEN otherwise.
 */
export async function requirePodAdmin(userId: string) {
  const podAdminWorkspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.systemSlug, "pod-admin"),
    columns: { id: true },
  });
  if (!podAdminWorkspace) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Pod administration workspace not found.",
    });
  }
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
      eq(workspaceMembers.userId, userId),
      inArray(workspaceMembers.role, ["admin", "owner"])
    ),
    columns: { role: true },
  });
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only pod administrators can manage pod-wide capabilities.",
    });
  }
}

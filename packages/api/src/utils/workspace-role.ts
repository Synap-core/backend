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
  if (!(await isPodAdmin(userId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only pod administrators can manage pod-wide capabilities.",
    });
  }
}

/**
 * Non-throwing pod-admin check — the boolean sibling of `requirePodAdmin`. Used
 * where a caller must BRANCH on admin-ness rather than fail (e.g. reveal foreign
 * per-user connections to an admin, but simply hide them from a non-admin instead
 * of erroring). Returns false when the pod-admin workspace is missing.
 */
export async function isPodAdmin(userId: string): Promise<boolean> {
  const podAdminWorkspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.systemSlug, "pod-admin"),
    columns: { id: true },
  });
  if (!podAdminWorkspace) return false;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
      eq(workspaceMembers.userId, userId),
      inArray(workspaceMembers.role, ["admin", "owner"])
    ),
    columns: { role: true },
  });
  return !!membership;
}

/**
 * Materialize the pod's owner/admins as members of `workspaceId` — idempotently.
 *
 * "Pod admins" here is the canonical `isPodAdmin` notion: members of the
 * `pod-admin` system workspace with role owner/admin (NOT `pod_members.pod_role`).
 * Each gets a `workspace_members` row on `workspaceId` — role `owner` for the pod
 * owner, `admin` for pod admins. That row grants WRITE
 * (`verifyPermission` → `getWorkspaceMembership` returns `{ role }` →
 * `checkPermissionOrPropose` admits the mutation) so pod admins can administer a
 * shared workspace's entities inline.
 *
 * SECURITY — callers MUST only invoke this for pod_visible/pod_joinable
 * workspaces. Adding a member row does NOT widen the pod-member READ floor
 * (`facetVisibilityConditions` / `podSharedFacetWhere` key on `pod_members`, not
 * `workspace_members`), but a pod-visible workspace is ALREADY pod-readable, so
 * this grants no new reads. Materializing into a PRIVATE workspace, by contrast,
 * WOULD widen its reads (a member row makes its entities visible) — never do it.
 *
 * Idempotent: a direct insert with `onConflictDoNothing()` on the
 * `(workspace_id, user_id)` unique index — NOT `WorkspaceMemberRepository.add`,
 * which is a bare insert that 23505s on a race — and it does NOT run the
 * invite-accept side-effects (`ensureTeamPersonForMember`): these are
 * auto-materialized admins, not domain team members. Users who are both owner
 * and admin of the pod-admin workspace resolve to `owner` (owner-first), so a
 * re-run never downgrades an owner to admin.
 */
export async function materializePodAdminsIntoWorkspace(
  workspaceId: string
): Promise<void> {
  const podAdminWorkspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.systemSlug, "pod-admin"),
    columns: { id: true },
  });
  if (!podAdminWorkspace) return;

  const podAdmins = await db.query.workspaceMembers.findMany({
    where: and(
      eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
      inArray(workspaceMembers.role, ["owner", "admin"])
    ),
    columns: { userId: true, role: true },
  });
  if (podAdmins.length === 0) return;

  // One row per user, owner-first: a user who is both owner and admin of the
  // pod-admin workspace materializes as `owner`.
  const roleByUser = new Map<string, "owner" | "admin">();
  for (const m of podAdmins) {
    if (roleByUser.get(m.userId) === "owner") continue;
    roleByUser.set(m.userId, m.role === "owner" ? "owner" : "admin");
  }

  await db
    .insert(workspaceMembers)
    .values(
      Array.from(roleByUser.entries()).map(([userId, role]) => ({
        workspaceId,
        userId,
        role,
      }))
    )
    .onConflictDoNothing();
}

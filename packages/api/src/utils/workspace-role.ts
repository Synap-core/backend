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

import {
  POD_ADMIN_ROLES,
  POD_ADMIN_SYSTEM_SLUG,
} from "@synap-core/types/console";
import { isSpaceManageRole } from "@synap-core/types/workspaces";
import { TRPCError } from "@trpc/server";
import { db, eq, and, inArray, isNull } from "@synap/database";
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
  if (!isSpaceManageRole(role)) {
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
 * of erroring). Returns false when the pod-admin workspace is missing. A FAILED
 * read (either query throwing) propagates — it never folds into `false`;
 * `assertPodAdmin` (trpc.ts) and the governance gate's rung-2.07 check both
 * rely on that. The slug and roles are `@synap-core/types/console`'s, so a
 * client that reads the person's role from their workspace list applies the
 * same rule.
 */
export async function isPodAdmin(userId: string): Promise<boolean> {
  return (await getPodAdminRole(userId)) !== null;
}

/** A pod-admin role: what makes a person a pod admin. */
export type PodAdminRole = (typeof POD_ADMIN_ROLES)[number];

/**
 * The person's pod-admin role — `owner` or `admin` of the `pod-admin` system
 * workspace — or null when they are neither. The query behind `isPodAdmin`, so
 * the two can never disagree; a FAILED read throws, never reads as null.
 */
export async function getPodAdminRole(
  userId: string
): Promise<PodAdminRole | null> {
  const podAdminWorkspace = await db.query.workspaces.findFirst({
    // An archived pod-admin space grants no admin power: the same rule as
    // `projectPodUserAccess` (@synap/database), so the two reads never split.
    where: and(
      eq(workspaces.systemSlug, POD_ADMIN_SYSTEM_SLUG),
      isNull(workspaces.archivedAt)
    ),
    columns: { id: true },
  });
  if (!podAdminWorkspace) return null;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
      eq(workspaceMembers.userId, userId),
      inArray(workspaceMembers.role, [...POD_ADMIN_ROLES])
    ),
    columns: { role: true },
  });
  return (membership?.role as PodAdminRole | undefined) ?? null;
}

/**
 * Does `target`'s pod-admin role outrank `actor`'s? The owner outranks an
 * admin, an admin outranks everyone else. A pod admin may not act on the
 * account of someone above them (e.g. unlink the owner's sign-in).
 */
export function podAdminRoleOutranks(
  target: PodAdminRole | null,
  actor: PodAdminRole | null
): boolean {
  const rank = (role: PodAdminRole | null) =>
    role === "owner" ? 2 : role === "admin" ? 1 : 0;
  return rank(target) > rank(actor);
}

/**
 * May `userId` manage an MCP server row in this scope? Workspace row → owner or
 * admin of that workspace; pod-wide row (`workspaceId` null) → pod admin.
 */
export async function canManageMcpServer(
  userId: string,
  workspaceId: string | null
): Promise<boolean> {
  if (!workspaceId) return isPodAdmin(userId);
  return isSpaceManageRole(await getWorkspaceRole(userId, workspaceId));
}

/**
 * THE management gate for an `mcp_servers` row — every door that writes one
 * (the settings router and the capability applier) calls it. Same scope rule as
 * `canManageMcpServer`; `level: "owner"` narrows a workspace row to its owner
 * (approval). Throws FORBIDDEN.
 */
export async function requireServerManager(
  userId: string,
  workspaceId: string | null,
  level: "admin" | "owner" = "admin"
): Promise<void> {
  if (!workspaceId) {
    await requirePodAdmin(userId);
    return;
  }
  const role = await getWorkspaceRole(userId, workspaceId);
  if (level === "owner") {
    if (role !== "owner") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only workspace owners can approve MCP server tool access.",
      });
    }
    return;
  }
  requireAdminRole(role);
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
 * workspaces. A pod-visible workspace is ALREADY pod-readable, so its own rows
 * gain no new readers. ONE widening remains, by design (decision B,
 * 2026-09-27): a member row in a space a SHARED ROLE is granted to admits that
 * role's pod-shared entities (`podSharedFacetGrantWhere` keys on
 * `workspace_members` ∪ owned spaces, AND `pod_members`) — an admin
 * administering the space sees what the space was granted. Materializing into a PRIVATE workspace, by contrast,
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

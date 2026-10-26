/**
 * Pod-authoritative access projection.
 *
 * This deliberately consumes only local membership snapshots. An external
 * issuer may request a session or grant, but it never defines what the Pod
 * considers active access.
 *
 * `readPodUserAccess` + `hasActivePodAccess` are the ONE answer to "does this
 * person still hold access here?" for every federation door that links or
 * re-admits a person (identity-link receipts, the invite-is-the-consent
 * link). Membership is read on each use, never from the moment of linking.
 *
 * Access = a live space or project membership, the Pod owner/admin role, or a
 * LIVE `pod_members` row (a pod invite on a pod with no ordinary space yet;
 * founder Q-B1, 0357). A removed person's row carries `removed_at`.
 */

import { eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import { projectMembers } from "../schema/project-members.js";
import { projects } from "../schema/projects.js";
import {
  podMembers,
  workspaceMembers,
  workspaces,
} from "../schema/workspaces.js";
import { livePodMemberWhere } from "../utils/pod-membership.js";

export type PodUserAccess = {
  podRole: "owner" | "admin" | "member";
  /** Holds a LIVE `pod_members` row (joined by a pod invite, not removed). */
  podMember: boolean;
  workspaceScopes: Array<{
    workspaceId: string;
    role: "owner" | "admin" | "editor" | "viewer";
  }>;
  projectScopes: Array<{
    projectId: string;
    workspaceId: string | null;
    role: "owner" | "admin" | "editor" | "viewer";
  }>;
};

type WorkspaceMembershipSnapshot = {
  workspaceId: string;
  role: string;
  systemSlug: string | null;
  workspaceArchivedAt?: Date | null;
};

type ProjectMembershipSnapshot = {
  projectId: string;
  workspaceId: string | null;
  role: string;
  status: string;
  workspaceArchivedAt?: Date | null;
  workspaceSystemSlug?: string | null;
};

const workspaceRoles = new Set(["owner", "admin", "editor", "viewer"]);

/**
 * Keep the Pod administration membership separate from user-facing scopes.
 * An owner/admin can still authenticate before creating an ordinary workspace;
 * callers decide whether that Pod-wide role is sufficient for their operation.
 */
export function projectPodUserAccess(
  memberships: readonly WorkspaceMembershipSnapshot[],
  projectMemberships: readonly ProjectMembershipSnapshot[] = [],
  podMember = false
): PodUserAccess {
  const podAdminMembership = memberships.find(
    (membership) =>
      membership.systemSlug === "pod-admin" && !membership.workspaceArchivedAt
  );
  const podRole =
    podAdminMembership?.role === "owner" || podAdminMembership?.role === "admin"
      ? podAdminMembership.role
      : "member";

  return {
    podRole,
    podMember,
    workspaceScopes: memberships.flatMap((membership) => {
      if (
        membership.systemSlug === "pod-admin" ||
        membership.workspaceArchivedAt ||
        !workspaceRoles.has(membership.role)
      ) {
        return [];
      }
      return [
        {
          workspaceId: membership.workspaceId,
          role: membership.role as PodUserAccess["workspaceScopes"][number]["role"],
        },
      ];
    }),
    projectScopes: projectMemberships.flatMap((membership) => {
      if (
        membership.status !== "active" ||
        (membership.workspaceId !== null &&
          (membership.workspaceArchivedAt || membership.workspaceSystemSlug)) ||
        !workspaceRoles.has(membership.role)
      ) {
        return [];
      }
      return [
        {
          projectId: membership.projectId,
          workspaceId: membership.workspaceId,
          role: membership.role as PodUserAccess["projectScopes"][number]["role"],
        },
      ];
    }),
  };
}

/**
 * `userId`'s current local memberships, projected. Three reads keyed by the
 * person's id (`workspace_members` and `project_members`, each joined to its
 * parent by primary key, and the `pod_members` unique index), so it costs
 * three index lookups per call. A failed read throws; it never reads as "no
 * access".
 *
 * `pod_members` counts only while LIVE (`livePodMemberWhere`): the row records
 * how a person joined, and `removeFromPod` stamps `removed_at` instead of
 * deleting it.
 */
export async function readPodUserAccess(
  userId: string,
  conn: Pick<typeof db, "select"> = db
): Promise<PodUserAccess> {
  const [memberships, projectMemberships, podMemberRows] = await Promise.all([
    conn
      .select({
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
        systemSlug: workspaces.systemSlug,
        workspaceArchivedAt: workspaces.archivedAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId)),
    conn
      .select({
        projectId: projectMembers.projectId,
        workspaceId: projects.workspaceId,
        role: projectMembers.role,
        status: projects.status,
        workspaceArchivedAt: workspaces.archivedAt,
        workspaceSystemSlug: workspaces.systemSlug,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .leftJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projectMembers.userId, userId)),
    conn
      .select({ id: podMembers.id })
      .from(podMembers)
      .where(livePodMemberWhere(userId))
      .limit(1),
  ]);
  return projectPodUserAccess(
    memberships,
    projectMemberships,
    podMemberRows.length > 0
  );
}

/**
 * Does `access` hold any live access on this Pod: a live space or project
 * membership, a live `pod_members` row, or the Pod owner/admin role (who may
 * hold no ordinary space yet)?
 */
export function hasActivePodAccess(access: PodUserAccess): boolean {
  return (
    access.workspaceScopes.length > 0 ||
    access.projectScopes.length > 0 ||
    access.podMember ||
    access.podRole === "owner" ||
    access.podRole === "admin"
  );
}

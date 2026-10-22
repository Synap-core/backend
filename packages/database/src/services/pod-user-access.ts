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
 */

import { eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import { projectMembers } from "../schema/project-members.js";
import { projects } from "../schema/projects.js";
import { workspaceMembers, workspaces } from "../schema/workspaces.js";

export type PodUserAccess = {
  podRole: "owner" | "admin" | "member";
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
  projectMemberships: readonly ProjectMembershipSnapshot[] = []
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
 * `userId`'s current local memberships, projected. Two reads keyed by the
 * person's id (`workspace_members` and `project_members`, each joined to its
 * parent by primary key), so it costs two index lookups per call. A failed
 * read throws; it never reads as "no access".
 *
 * Deliberately NOT `pod_members`: that row records how a person joined and is
 * not removed with their memberships, so it would keep a removed person "in".
 */
export async function readPodUserAccess(
  userId: string,
  conn: Pick<typeof db, "select"> = db
): Promise<PodUserAccess> {
  const [memberships, projectMemberships] = await Promise.all([
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
  ]);
  return projectPodUserAccess(memberships, projectMemberships);
}

/**
 * Does `access` hold any live access on this Pod: a live space or project
 * membership, or the Pod owner/admin role (who may hold no ordinary space
 * yet)?
 */
export function hasActivePodAccess(access: PodUserAccess): boolean {
  return (
    access.workspaceScopes.length > 0 ||
    access.projectScopes.length > 0 ||
    access.podRole === "owner" ||
    access.podRole === "admin"
  );
}

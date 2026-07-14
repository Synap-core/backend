/**
 * Pod-authoritative access projection.
 *
 * This deliberately consumes only local membership snapshots. An external
 * issuer may request a session or grant, but it never defines what the Pod
 * considers active access.
 */

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

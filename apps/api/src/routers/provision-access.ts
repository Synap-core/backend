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

type MembershipSnapshot = {
  workspaceId: string;
  role: string;
  systemSlug: string | null;
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

/** Keep the Pod's system administration role separate from user workspaces. */
export function projectPodUserAccess(
  memberships: readonly MembershipSnapshot[],
  projectMemberships: readonly ProjectMembershipSnapshot[] = []
): PodUserAccess {
  const podAdminMembership = memberships.find(
    (membership) => membership.systemSlug === "pod-admin"
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

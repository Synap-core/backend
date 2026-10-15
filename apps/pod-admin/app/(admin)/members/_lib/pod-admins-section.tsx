"use client";

/**
 * Pod admins — the humans who own or administer the pod-admin workspace, so
 * may sign in to this console. Read from that workspace's member list; each
 * row opens the shared member drawer with the full workspace breakdown.
 */

import { ShieldCheck } from "lucide-react";
import { useEffect, useMemo } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import type { PodMember } from "./helpers";

export function PodAdminsSection({
  podMembers,
  onOpenMember,
}: {
  podMembers: PodMember[] | undefined;
  onOpenMember: (member: PodMember, isPodAdmin: boolean) => void;
}) {
  const workspacesQuery = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });

  const podAdminWorkspaceId = useMemo(() => {
    if (!workspacesQuery.data) return undefined;
    for (const ws of workspacesQuery.data) {
      const settings = (ws.settings ?? {}) as Record<string, unknown>;
      if (settings.systemSlug === "pod-admin") return ws.id;
    }
    return undefined;
  }, [workspacesQuery.data]);

  const membersQuery = trpc.workspaces.listMembers.useQuery(
    { workspaceId: podAdminWorkspaceId ?? "" },
    { enabled: !!podAdminWorkspaceId, staleTime: 60_000 }
  );

  useEffect(() => {
    if (workspacesQuery.isError || membersQuery.isError) {
      redirectToLoginIfUnauthorized(
        workspacesQuery.error ?? membersQuery.error
      );
    }
  }, [
    workspacesQuery.isError,
    workspacesQuery.error,
    membersQuery.isError,
    membersQuery.error,
  ]);
  const isAuthRedirecting =
    workspacesQuery.error?.data?.code === "UNAUTHORIZED" ||
    membersQuery.error?.data?.code === "UNAUTHORIZED";

  const isLoading =
    workspacesQuery.isLoading ||
    (!!podAdminWorkspaceId && membersQuery.isLoading) ||
    isAuthRedirecting;
  const isError = workspacesQuery.isError || membersQuery.isError;

  const admins = useMemo(() => {
    if (!membersQuery.data) return [];
    return membersQuery.data
      .filter(
        (m) =>
          m.user?.userType === "human" &&
          (m.role === "owner" || m.role === "admin")
      )
      .map((m) => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
      }));
  }, [membersQuery.data]);

  return (
    <SectionCard
      title="Pod admins"
      hint="People who can sign in to this console"
      actions={
        admins.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {admins.length} {admins.length === 1 ? "admin" : "admins"}
          </span>
        ) : null
      }
    >
      {isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : isError ? (
        <ResourceRowError message="Couldn't load pod admins." />
      ) : admins.length === 0 ? (
        <ResourceRowEmpty message="No pod admins yet — invite one above." />
      ) : (
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {admins.map((admin) => {
            // Look up full workspace breakdown from the shared pod members query.
            const fullMember = podMembers?.find((m) => m.id === admin.id) ?? {
              id: admin.id,
              email: admin.email,
              name: admin.name,
              avatarUrl: admin.avatarUrl,
              primaryRole: admin.role as PodMember["primaryRole"],
              workspaceCount: 0,
              workspaces: [],
            };
            return (
              <div
                key={admin.id}
                data-row-id={admin.id}
                className="rounded-md transition-shadow"
              >
                <ResourceRow
                  Icon={ShieldCheck}
                  primary={admin.name ?? admin.email}
                  secondary={`${admin.email} · ${admin.role}`}
                  status={{ kind: "healthy", label: admin.role }}
                  onSelect={() => onOpenMember(fullMember, true)}
                />
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

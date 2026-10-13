"use client";

/**
 * Members by role — every human with at least one workspace membership,
 * deduped and grouped under their highest role.
 */

import { CircleUser } from "lucide-react";
import { useMemo } from "react";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import {
  groupByPrimaryRole,
  MEMBER_ROLES,
  rolePillKind,
  type PodMember,
} from "./helpers";

export function MembersByRoleSection({
  members,
  isLoading,
  isError,
  onOpenMember,
}: {
  members: PodMember[];
  isLoading: boolean;
  isError: boolean;
  onOpenMember: (member: PodMember) => void;
}) {
  const grouped = useMemo(() => groupByPrimaryRole(members), [members]);

  return (
    <SectionCard
      title="Members by role"
      hint="Every human with at least one workspace membership"
      actions={
        members.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {members.length} {members.length === 1 ? "member" : "members"}
          </span>
        ) : null
      }
    >
      {isLoading ? (
        <ResourceRowSkeleton count={3} />
      ) : isError ? (
        <ResourceRowError message="Couldn't load workspace members." />
      ) : members.length === 0 ? (
        <ResourceRowEmpty message="No workspace members yet." />
      ) : (
        <div className="flex flex-col gap-3">
          {MEMBER_ROLES.map((role) => {
            const bucket = grouped[role];
            if (!bucket || bucket.length === 0) return null;
            return (
              <div key={role} className="flex flex-col">
                <div className="px-3 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wider text-foreground/40">
                  {role}s · {bucket.length}
                </div>
                <div className="-mx-2 divide-y divide-foreground/[0.05]">
                  {bucket.map((m) => (
                    <div
                      key={m.id}
                      data-row-id={m.id}
                      className="rounded-md transition-shadow"
                    >
                      <ResourceRow
                        Icon={CircleUser}
                        primary={m.name ?? m.email}
                        secondary={`${m.email} · in ${m.workspaceCount} ${
                          m.workspaceCount === 1 ? "workspace" : "workspaces"
                        }`}
                        status={{
                          kind: rolePillKind(m.primaryRole),
                          label: m.primaryRole,
                        }}
                        onSelect={() => onOpenMember(m)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

"use client";

/**
 * Overview tab — workspace metadata + owner card + settings JSON.
 * Mirrors the content that was previously in WorkspaceDrawer on the list page.
 */

import { useMemo } from "react";
import { trpc } from "../../../../../lib/trpc";
import { SectionCard } from "../../../components/section-card";
import { formatRelative } from "../../../people/_lib/helpers";

interface Workspace {
  id: string;
  name: string;
  type: string;
  description: string | null;
  settings: Record<string, unknown>;
  memberCount: number;
  subscriptionTier: string | null;
  subscriptionStatus: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] uppercase tracking-wider text-foreground/45">
        {label}
      </span>
      <span className="truncate text-right text-[12.5px] text-foreground">
        {value}
      </span>
    </div>
  );
}

export function OverviewTab({ ws }: { ws: Workspace }) {
  const membersQuery = trpc.workspaces.listMembers.useQuery(
    { workspaceId: ws.id },
    { staleTime: 60_000 }
  );

  const owner = useMemo(() => {
    if (!membersQuery.data) return null;
    return (
      (
        membersQuery.data as Array<{
          id: string;
          role: string;
          userId: string;
          user: {
            name: string | null;
            email: string | null;
            userType?: string | null;
          };
        }>
      ).find((m) => m.role === "owner" && m.user?.userType === "human") ?? null
    );
  }, [membersQuery.data]);

  const settingsPretty = JSON.stringify(ws.settings ?? {}, null, 2);

  return (
    <div className="flex flex-col gap-5">
      <SectionCard title="Details">
        <div className="flex flex-col gap-3 pt-1">
          {ws.description ? (
            <p className="text-[12.5px] text-foreground/55 pb-1">
              {ws.description}
            </p>
          ) : null}
          <DetailRow label="Type" value={ws.type} />
          <DetailRow
            label="Members"
            value={`${ws.memberCount} ${ws.memberCount === 1 ? "member" : "members"}`}
          />
          <DetailRow
            label="Created"
            value={ws.createdAt ? new Date(ws.createdAt).toLocaleString() : "—"}
          />
          <DetailRow
            label="Last update"
            value={ws.updatedAt ? formatRelative(new Date(ws.updatedAt)) : "—"}
          />
          <DetailRow
            label="Subscription"
            value={
              ws.subscriptionTier
                ? `${ws.subscriptionTier}${ws.subscriptionStatus ? ` · ${ws.subscriptionStatus}` : ""}`
                : "—"
            }
          />
        </div>
      </SectionCard>

      <SectionCard title="Owner">
        {membersQuery.isLoading ? (
          <p className="text-[12px] text-foreground/55 py-2">Loading…</p>
        ) : owner ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-foreground/[0.06] bg-foreground/[0.02] px-3 py-2 mt-1">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[12.5px] font-medium text-foreground">
                {owner.user.name ?? owner.user.email}
              </span>
              <span className="truncate font-mono text-[10.5px] text-foreground/40">
                {owner.user.email}
              </span>
            </div>
            <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] text-foreground/55">
              owner
            </span>
          </div>
        ) : (
          <p className="text-[12px] text-foreground/55 py-2">
            No human owner found.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Settings">
        <pre className="max-h-[300px] overflow-auto rounded-md border border-foreground/[0.06] bg-foreground/[0.02] p-3 font-mono text-[10.5px] text-foreground/70 mt-1">
          {settingsPretty}
        </pre>
      </SectionCard>
    </div>
  );
}

"use client";

/**
 * Audit → Proposals sub-tab.
 *
 * Pod-level proposals only — those with `workspaceId === null`.  The
 * `proposals.list` procedure has a `workspaceId` filter but no "pod-only"
 * flag, so we pull a generous slice of all statuses and filter client-side.
 *
 * TODO(phase-C+): add a server-side "pod-only" filter to `proposals.list`.
 */

import { Button, Chip, useDisclosure } from "@heroui/react";
import { Mailbox } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { DetailDrawer } from "../../components/detail-drawer";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import type { StatusKind } from "../../components/status-pill";
import { useFocusRow } from "../../components/use-focus-row";
import type { AuditFilters } from "./filter-bar";
import { formatRelative, shortId } from "./format";

type ProposalStatusUI = "pending" | "validated" | "rejected" | "all";

interface ProposalRow {
  id: string;
  workspaceId: string | null;
  targetType: string;
  targetId: string;
  proposalType: string;
  status: string;
  agentUserId: string | null;
  createdBy: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  reviewedAt: string | Date | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  data: Record<string, unknown> | null;
  request?: unknown;
}

const STATUS_LABEL: Record<string, { kind: StatusKind; label: string }> = {
  pending: { kind: "stale", label: "Pending" },
  approved: { kind: "healthy", label: "Approved" },
  auto_approved: { kind: "healthy", label: "Auto-approved" },
  rejected: { kind: "down", label: "Rejected" },
};

export function ProposalsSection({ filters }: { filters: AuditFilters }) {
  const [statusFilter, setStatusFilter] = useState<ProposalStatusUI>("all");

  const list = trpc.proposals.list.useQuery(
    { status: statusFilter, limit: 100 },
    { staleTime: 30_000 }
  );

  const items = (list.data?.items ?? []) as unknown as ProposalRow[];

  // Filter to pod-level (workspaceId === null) + apply date range.
  const podLevel = useMemo(() => {
    const fromMs = filters.fromDate ? new Date(filters.fromDate).getTime() : 0;
    const toMs = filters.toDate
      ? new Date(filters.toDate).getTime()
      : Number.POSITIVE_INFINITY;
    return items.filter((p) => {
      if (p.workspaceId != null) return false;
      const t = new Date(p.createdAt).getTime();
      if (t < fromMs || t > toMs) return false;
      if (filters.userIds.length > 0) {
        const userId = p.createdBy ?? p.agentUserId ?? "";
        if (!filters.userIds.includes(userId)) return false;
      }
      return true;
    });
  }, [items, filters.fromDate, filters.toDate, filters.userIds]);

  const [selected, setSelected] = useState<ProposalRow | null>(null);
  const drawer = useDisclosure({
    isOpen: !!selected,
    onClose: () => setSelected(null),
  });

  // ?focus=<proposalId> from ⌘K. Open the drawer once the matching proposal
  // is rendered (proposals only includes pod-level rows).
  const focusId = useFocusRow({ ready: !list.isLoading });
  useEffect(() => {
    if (!focusId || selected) return;
    const found = podLevel.find((p) => p.id === focusId);
    if (found) setSelected(found);
  }, [focusId, podLevel]);

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        {(
          ["all", "pending", "validated", "rejected"] as ProposalStatusUI[]
        ).map((s) => {
          const active = statusFilter === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={[
                "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                active
                  ? "bg-foreground/[0.08] text-foreground ring-1 ring-inset ring-foreground/15"
                  : "text-foreground/55 hover:bg-content2/50 hover:text-foreground",
              ].join(" ")}
            >
              {s === "validated"
                ? "Approved"
                : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          );
        })}
      </div>

      <div className="rounded-lg ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]">
        {list.isLoading ? (
          <ResourceRowSkeleton count={4} />
        ) : list.isError ? (
          <ResourceRowError
            message="Couldn't load proposals."
            onRetry={() => void list.refetch()}
          />
        ) : podLevel.length === 0 ? (
          <ResourceRowEmpty message="No pod-level proposals match these filters." />
        ) : (
          podLevel.map((p) => (
            <div
              key={p.id}
              data-row-id={p.id}
              className="rounded-md transition-shadow"
            >
              <ResourceRow
                Icon={Mailbox}
                primary={`${prettyTargetType(p.targetType)} · ${p.proposalType}`}
                secondary={[
                  p.agentUserId ? `agent ${shortId(p.agentUserId)}` : null,
                  formatRelative(p.createdAt),
                  p.workspaceId == null ? "pod-level" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                status={
                  STATUS_LABEL[p.status] ?? {
                    kind: "unknown" as StatusKind,
                    label: p.status,
                  }
                }
                onSelect={() => setSelected(p)}
              />
            </div>
          ))
        )}
      </div>

      <ProposalDrawer
        proposal={selected}
        isOpen={drawer.isOpen}
        onOpenChange={drawer.onOpenChange}
      />
    </>
  );
}

function prettyTargetType(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function ProposalDrawer({
  proposal,
  isOpen,
  onOpenChange,
}: {
  proposal: ProposalRow | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DetailDrawer
      isOpen={isOpen}
      onClose={() => onOpenChange(false)}
      title="Proposal detail"
      subtitle={
        proposal ? (
          <code className="font-mono">
            {proposal.proposalType} · {proposal.targetType}
          </code>
        ) : undefined
      }
      headerAccessory={
        <span
          className="glass-icon flex h-7 w-7 items-center justify-center"
          style={{ background: "rgba(52, 211, 153, 0.15)" }}
        >
          <Mailbox className="h-3.5 w-3.5 text-foreground/85" />
        </span>
      }
    >
      {proposal ? (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[11.5px]">
            <Field
              k="Status"
              v={STATUS_LABEL[proposal.status]?.label ?? proposal.status}
            />
            <Field k="Target type" v={proposal.targetType} />
            <Field k="Target ID" v={proposal.targetId} mono />
            <Field
              k="Created"
              v={new Date(proposal.createdAt).toLocaleString()}
            />
            <Field
              k="Reviewed"
              v={
                proposal.reviewedAt
                  ? new Date(proposal.reviewedAt).toLocaleString()
                  : "—"
              }
            />
            <Field k="Reviewer" v={proposal.reviewedBy ?? "—"} mono />
            <Field k="Agent" v={proposal.agentUserId ?? "—"} mono />
            <Field k="Author" v={proposal.createdBy ?? "—"} mono />
          </dl>

          {proposal.rejectionReason && (
            <div className="mt-4 rounded-md bg-status-down/10 p-3 text-[12px] text-status-down ring-1 ring-inset ring-status-down/30">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide">
                Rejection reason
              </p>
              {proposal.rejectionReason}
            </div>
          )}

          <div className="mt-4">
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-foreground/45">
              Payload
            </p>
            <pre className="overflow-auto rounded-md bg-foreground/[0.04] p-3 font-mono text-[11px] text-foreground/85 ring-1 ring-inset ring-foreground/10">
              {JSON.stringify(proposal.data, null, 2)}
            </pre>
          </div>

          {proposal.request != null && (
            <div className="mt-4">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-foreground/45">
                Request
              </p>
              <pre className="overflow-auto rounded-md bg-foreground/[0.04] p-3 font-mono text-[11px] text-foreground/85 ring-1 ring-inset ring-foreground/10">
                {JSON.stringify(proposal.request, null, 2)}
              </pre>
            </div>
          )}
        </>
      ) : null}
    </DetailDrawer>
  );
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10.5px] uppercase tracking-wide text-foreground/45">
        {k}
      </dt>
      <dd
        className={[
          "break-all text-foreground/85",
          mono ? "font-mono text-[10.5px]" : "",
        ].join(" ")}
      >
        {v}
      </dd>
    </div>
  );
}

void Chip;
void Button;

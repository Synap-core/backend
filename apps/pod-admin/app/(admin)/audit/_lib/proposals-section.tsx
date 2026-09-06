"use client";

/**
 * Audit → Proposals sub-tab.
 *
 * Every proposal the viewer is entitled to see — pod-wide AND workspace-scoped.
 * Almost every governed AI write is workspace-scoped, so a pod-wide-only list
 * showed a fraction of the real governance history.
 */

import { Button, Chip, useDisclosure } from "@heroui/react";
import { Mailbox } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  resolveObjectNoun,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
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

/**
 * Status → pill COLOUR only. The pill's WORD comes from
 * `resolveStatusLabel` (`@synap-core/types/vocabulary`), the SSOT.
 *
 * This used to be one map carrying both, which is how the same status ends up
 * spelled two ways in two surfaces — the defect the vocabulary rule exists to
 * prevent. Colour is presentation and stays local; the label is domain
 * vocabulary and never is.
 */
const STATUS_KIND: Record<string, StatusKind> = {
  pending: "stale",
  approved: "healthy",
  auto_approved: "healthy",
  rejected: "down",
};

/**
 * The list filter's `validated` is an API bucket token, not a row status: rows
 * come back `approved` / `auto_approved`. Mapping it onto the status it
 * SELECTS keeps the SSOT as the source of the word — rendering the raw token
 * would put "Validated" in front of users, a word this product uses nowhere
 * else, while hand-writing "Approved" here is the local override the rule
 * forbids.
 */
const FILTER_STATUS: Record<string, string> = {
  validated: "approved",
};

function filterLabel(filter: string): string {
  if (filter === "all") return "All";
  return resolveStatusLabel(FILTER_STATUS[filter] ?? filter);
}

export function ProposalsSection({ filters }: { filters: AuditFilters }) {
  const [statusFilter, setStatusFilter] = useState<ProposalStatusUI>("all");

  /* `workspaceId` is OMITTED on purpose. The filter is three-state on the
     server (`scope-conditions.ts`): `null` means pod-wide only, a string means
     that one workspace, and `undefined` falls to `proposalUserFloor` — the
     viewer's own lens union what they authored. Omitting it therefore widens
     the list to everything this user may already review and grants no reach.
     The ⌘K palette omits it too, so the two windows still match: a result
     ranked in search can always be focused here. */
  const list = trpc.proposals.list.useQuery(
    { status: statusFilter, limit: 100 },
    { staleTime: 30_000 }
  );

  /* Names for the workspace column. Once the list spans workspaces a bare row
     is ambiguous, and `proposals.list` enriches author/target/session labels
     but NOT the workspace — the row carries only `workspaceId`. */
  const workspaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });
  const workspaceNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of workspaces.data ?? []) map.set(w.id, w.name);
    return map;
  }, [workspaces.data]);

  function workspaceLabel(workspaceId: string | null): string {
    if (workspaceId == null) return "Pod-wide";
    return (
      workspaceNames.get(workspaceId) ?? `Workspace ${shortId(workspaceId)}`
    );
  }

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    if (list.isError) {
      redirectToLoginIfUnauthorized(list.error);
    }
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  const items = (list.data?.items ?? []) as unknown as ProposalRow[];

  // Client-side narrowing for the axes the list procedure does not take:
  // the filter bar's date range and actor selection.
  const visible = useMemo(() => {
    const fromMs = filters.fromDate ? new Date(filters.fromDate).getTime() : 0;
    const toMs = filters.toDate
      ? new Date(filters.toDate).getTime()
      : Number.POSITIVE_INFINITY;
    return items.filter((p) => {
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

  /**
   * `?focus=<proposalId>` from ⌘K.
   *
   * Resolved against the UNFILTERED rows, not the date-filtered `visible`.
   * This tab seeds its range from `defaultDateRange()` while ⌘K queries with
   * no date bound at all — so looking the row up in the filtered set meant any
   * proposal older than that window was listed in search, navigated to, and
   * then silently opened nothing.
   *
   * An explicit navigation is a stronger signal than an incidental default
   * filter, so focus wins. Aligning the workspace axis earlier fixed half of
   * this; the date axis was the other half.
   */
  const focusId = useFocusRow({ ready: !list.isLoading });
  useEffect(() => {
    if (!focusId || selected) return;
    const found = items.find((p) => p.id === focusId);
    if (found) setSelected(found);
  }, [focusId, items, selected]);

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
              {filterLabel(s)}
            </button>
          );
        })}
      </div>

      <div className="rounded-lg ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]">
        {list.isLoading || isAuthRedirecting ? (
          <ResourceRowSkeleton count={4} />
        ) : list.isError ? (
          <ResourceRowError
            message="Couldn't load proposals."
            onRetry={() => void list.refetch()}
          />
        ) : visible.length === 0 ? (
          <ResourceRowEmpty message="No proposals you can review match these filters." />
        ) : (
          visible.map((p) => (
            <div
              key={p.id}
              data-row-id={p.id}
              className="rounded-md transition-shadow"
            >
              <ResourceRow
                Icon={Mailbox}
                primary={`${prettyTargetType(p.targetType)} · ${p.proposalType}`}
                secondary={[
                  workspaceLabel(p.workspaceId),
                  p.agentUserId ? `agent ${shortId(p.agentUserId)}` : null,
                  formatRelative(p.createdAt),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                status={{
                  kind: STATUS_KIND[p.status] ?? ("unknown" as StatusKind),
                  label: resolveStatusLabel(p.status),
                }}
                onSelect={() => setSelected(p)}
              />
            </div>
          ))
        )}
      </div>

      <ProposalDrawer
        proposal={selected}
        workspaceLabel={selected ? workspaceLabel(selected.workspaceId) : "—"}
        isOpen={drawer.isOpen}
        onOpenChange={drawer.onOpenChange}
      />
    </>
  );
}

/**
 * A proposal's target type is an object kind — so the noun comes from the
 * registry, not from upper-casing the token. `resolveObjectNoun` falls back to
 * `humanizeToken`, so a kind added to the DB tomorrow still reads as words
 * rather than leaking raw.
 */
function prettyTargetType(t: string): string {
  return resolveObjectNoun(t);
}

function ProposalDrawer({
  proposal,
  workspaceLabel,
  isOpen,
  onOpenChange,
}: {
  proposal: ProposalRow | null;
  workspaceLabel: string;
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
            <Field k="Status" v={resolveStatusLabel(proposal.status)} />
            <Field k="Workspace" v={workspaceLabel} />
            {/* `targetType` used to render raw here while the row above it
                humanized the same value — the two-spellings defect, inside one
                component. Both now go through the registry. */}
            <Field k="Target type" v={prettyTargetType(proposal.targetType)} />
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

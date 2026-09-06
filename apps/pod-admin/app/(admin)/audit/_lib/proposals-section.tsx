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

  /* `workspaceId: null` filters POD-LEVEL ON THE SERVER. This used to ask for
     the newest 100 proposals across every workspace and then drop the
     workspace-scoped ones in the browser, which had two consequences: pod-level
     history was silently truncated by workspace noise, and the window stopped
     matching the ⌘K palette's (which does filter server-side). A search result
     ranked #150 overall would navigate here and quietly find nothing to focus. */
  const list = trpc.proposals.list.useQuery(
    { workspaceId: null, status: statusFilter, limit: 100 },
    { staleTime: 30_000 }
  );

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    if (list.isError) {
      redirectToLoginIfUnauthorized(list.error, "/audit");
    }
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  const items = (list.data?.items ?? []) as unknown as ProposalRow[];

  // Date range, plus a belt-and-braces repeat of the pod-level predicate the
  // server now applies. Kept so this list can never render a workspace row if
  // the server filter is ever relaxed.
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
            <Field k="Status" v={resolveStatusLabel(proposal.status)} />
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

"use client";

/**
 * Audit → Approval queue sub-tab.
 *
 * Same data source as the Overview's Approval queue card, but with
 * checkbox-driven bulk actions. Backed by:
 *   • trpc.proposals.list({ status: "pending", limit: 100 })
 *   • trpc.proposals.batchApprove({ proposalIds, comment? })
 *   • trpc.proposals.batchReject({ proposalIds, reason? })   (TODO: confirm)
 *
 * The brief says "pod-level proposals only" — so we mirror the Proposals
 * sub-tab and filter to `workspaceId == null`. Bulk approve/reject use
 * the batch endpoints; we surface per-row errors when partial failure
 * occurs.
 */

import {
  Button,
  Checkbox,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
  addToast,
  useDisclosure,
} from "@heroui/react";
import { Check, Mailbox, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import type { AuditFilters } from "./filter-bar";
import { formatRelative, shortId } from "./format";

interface PendingProposal {
  id: string;
  workspaceId: string | null;
  targetType: string;
  targetId: string;
  proposalType: string;
  agentUserId: string | null;
  createdBy: string | null;
  createdAt: string | Date;
  data: Record<string, unknown> | null;
}

export function ApprovalQueueSection({ filters }: { filters: AuditFilters }) {
  const list = trpc.proposals.list.useQuery(
    { status: "pending", limit: 100 },
    { staleTime: 15_000, refetchInterval: 60_000 }
  );

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    if (list.isError) {
      redirectToLoginIfUnauthorized(list.error, "/audit");
    }
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  const utils = trpc.useUtils();

  const items = (list.data?.items ?? []) as unknown as PendingProposal[];

  const podLevel = useMemo(() => {
    const fromMs = filters.fromDate ? new Date(filters.fromDate).getTime() : 0;
    const toMs = filters.toDate
      ? new Date(filters.toDate).getTime()
      : Number.POSITIVE_INFINITY;
    return items.filter((p) => {
      if (p.workspaceId != null) return false;
      const t = new Date(p.createdAt).getTime();
      if (t < fromMs || t > toMs) return false;
      return true;
    });
  }, [items, filters.fromDate, filters.toDate]);

  // Search term — narrows the visible list further.
  const [search, setSearch] = useState("");
  const visible = useMemo(() => {
    if (!search.trim()) return podLevel;
    const q = search.toLowerCase();
    return podLevel.filter((p) =>
      [p.targetType, p.proposalType, p.targetId, p.agentUserId ?? ""]
        .filter(Boolean)
        .some((s) => s.toLowerCase().includes(q))
    );
  }, [podLevel, search]);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const allSelected =
    visible.length > 0 && visible.every((p) => selectedIds.has(p.id));
  const someSelected = selectedIds.size > 0 && !allSelected;

  function toggleAll() {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(visible.map((p) => p.id)));
  }
  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const batchApprove = trpc.proposals.batchApprove.useMutation({
    onSuccess: (res) => {
      void utils.proposals.list.invalidate();
      const failures =
        (
          res as unknown as {
            results?: Array<{
              proposalId: string;
              success: boolean;
              error?: string;
            }>;
          }
        )?.results?.filter((r) => !r.success) ?? [];
      if (failures.length === 0) {
        addToast({
          title: `Approved ${selectedIds.size} proposal${selectedIds.size === 1 ? "" : "s"}`,
          color: "success",
        });
      } else {
        addToast({
          title: `Approved with ${failures.length} failure${failures.length === 1 ? "" : "s"}`,
          description: failures
            .slice(0, 3)
            .map((f) => `${shortId(f.proposalId)}: ${f.error ?? "?"}`)
            .join(" · "),
          color: "warning",
        });
      }
      setSelectedIds(new Set());
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err, "/audit")) return;
      addToast({
        title: "Approve failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const batchReject = trpc.proposals.batchReject.useMutation({
    onSuccess: () => {
      void utils.proposals.list.invalidate();
      addToast({
        title: `Rejected ${selectedIds.size} proposal${selectedIds.size === 1 ? "" : "s"}`,
        color: "default",
      });
      setSelectedIds(new Set());
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err, "/audit")) return;
      addToast({
        title: "Reject failed",
        description: err.message,
        color: "danger",
      });
    },
  });

  const [rejectOpen, setRejectOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {/* Search + bulk actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by type, target, agent…"
          value={search}
          onValueChange={setSearch}
          size="sm"
          variant="bordered"
          radius="md"
          className="max-w-[280px]"
          classNames={{
            inputWrapper:
              "h-8 min-h-8 bg-foreground/[0.04] border-foreground/10 hover:border-foreground/20 data-[hover=true]:bg-foreground/[0.06]",
            input: "text-[12px]",
          }}
          isClearable
          onClear={() => setSearch("")}
        />

        <div className="ml-auto flex items-center gap-2">
          {selectedIds.size > 0 && (
            <Chip
              size="sm"
              variant="flat"
              radius="sm"
              className="bg-foreground/[0.06] text-[11px] tabular text-foreground/65"
            >
              {selectedIds.size} selected
            </Chip>
          )}
          <Button
            size="sm"
            variant="flat"
            color="success"
            radius="md"
            startContent={<Check className="h-3.5 w-3.5" />}
            isDisabled={selectedIds.size === 0 || batchApprove.isPending}
            isLoading={batchApprove.isPending}
            onPress={() =>
              batchApprove.mutate({
                proposalIds: Array.from(selectedIds),
              })
            }
          >
            Approve selected
          </Button>
          <Button
            size="sm"
            variant="flat"
            color="danger"
            radius="md"
            startContent={<X className="h-3.5 w-3.5" />}
            isDisabled={selectedIds.size === 0 || batchReject.isPending}
            isLoading={batchReject.isPending}
            onPress={() => setRejectOpen(true)}
          >
            Reject selected
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]">
        {/* Header */}
        {visible.length > 0 && (
          <div className="flex h-9 items-center gap-3 border-b border-foreground/[0.05] px-3 text-[10.5px] uppercase tracking-wide text-foreground/45">
            <Checkbox
              size="sm"
              isSelected={allSelected}
              isIndeterminate={someSelected}
              onValueChange={toggleAll}
              aria-label="Select all"
            />
            <span className="w-[140px] shrink-0">Target</span>
            <span className="w-[100px] shrink-0">Type</span>
            <span className="min-w-0 flex-1">Agent / actor</span>
            <span className="w-[120px] shrink-0 text-right">Created</span>
          </div>
        )}

        {list.isLoading || isAuthRedirecting ? (
          <ResourceRowSkeleton count={4} />
        ) : list.isError ? (
          <ResourceRowError
            message="Couldn't load approval queue."
            onRetry={() => void list.refetch()}
          />
        ) : visible.length === 0 ? (
          <ResourceRowEmpty
            message={
              search ? "No matching proposals." : "Nothing waiting for review."
            }
          />
        ) : (
          visible.map((p) => (
            <ApprovalRow
              key={p.id}
              proposal={p}
              selected={selectedIds.has(p.id)}
              onToggle={() => toggleOne(p.id)}
            />
          ))
        )}
      </div>

      {rejectOpen && (
        <BulkRejectModal
          count={selectedIds.size}
          isPending={batchReject.isPending}
          onClose={() => setRejectOpen(false)}
          onConfirm={async (reason) => {
            await batchReject.mutateAsync({
              proposalIds: Array.from(selectedIds),
              reason,
            });
            setRejectOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ApprovalRow({
  proposal,
  selected,
  onToggle,
}: {
  proposal: PendingProposal;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={[
        "flex h-12 items-center gap-3 border-b border-foreground/[0.05] px-3 last:border-b-0",
        "transition-colors",
        selected ? "bg-primary/[0.06]" : "hover:bg-content2/40",
      ].join(" ")}
    >
      <Checkbox
        size="sm"
        isSelected={selected}
        onValueChange={onToggle}
        aria-label="Select proposal"
      />
      <Mailbox className="h-3.5 w-3.5 shrink-0 text-foreground/45" />
      <div className="w-[140px] shrink-0 truncate text-[12px] text-foreground/85">
        {proposal.targetType}
      </div>
      <div className="w-[100px] shrink-0 truncate text-[11.5px] text-foreground/55">
        {proposal.proposalType}
      </div>
      <div className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/55">
        {proposal.agentUserId
          ? `agent ${shortId(proposal.agentUserId)}`
          : proposal.createdBy
            ? shortId(proposal.createdBy)
            : "—"}
      </div>
      <div className="w-[120px] shrink-0 text-right text-[11px] tabular text-foreground/45">
        {formatRelative(proposal.createdAt)}
      </div>
    </div>
  );
}

function BulkRejectModal({
  count,
  isPending,
  onClose,
  onConfirm,
}: {
  count: number;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const { isOpen, onOpenChange } = useDisclosure({
    defaultOpen: true,
    onClose,
  });
  const [reason, setReason] = useState("");

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <span
            className="glass-icon flex h-7 w-7 items-center justify-center"
            style={{ background: "rgba(248, 113, 113, 0.18)" }}
          >
            <X className="h-3.5 w-3.5 text-foreground/85" />
          </span>
          <span className="font-medium">
            Reject {count} proposal{count === 1 ? "" : "s"}
          </span>
        </ModalHeader>
        <ModalBody className="gap-2 pb-2">
          <Textarea
            label="Reason (optional)"
            placeholder="Optional rejection note shown to the agent."
            value={reason}
            onValueChange={setReason}
            minRows={3}
            size="sm"
          />
        </ModalBody>
        <ModalFooter>
          <Button
            variant="light"
            size="sm"
            radius="md"
            onPress={onClose}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            color="danger"
            size="sm"
            radius="md"
            isLoading={isPending}
            onPress={() => void onConfirm(reason.trim())}
          >
            Reject
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

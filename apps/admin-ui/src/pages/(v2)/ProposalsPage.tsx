import { Fragment, useState } from "react";
import { Button, Chip, Spinner, Text } from "@heroui/react";
import {
  IconCheckbox,
  IconCheck,
  IconX,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing, typography } from "../../theme/tokens";

const inputClass =
  "border-default-200 bg-background text-foreground focus:border-accent rounded-lg border px-3 py-2 text-sm outline-none";

const STATUS_COLORS: Record<string, "warning" | "success" | "danger"> = {
  pending: "warning",
  validated: "success",
  rejected: "danger",
};

type ProposalStatus = "pending" | "validated" | "rejected" | "all";
type TargetType = "entity" | "view" | "document" | "whiteboard";

function timeSince(date: Date | string) {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function ProposalsPage() {
  const { workspaceId } = useWorkspace();
  const [status, setStatus] = useState<ProposalStatus>("pending");
  const [targetType, setTargetType] = useState<TargetType | "">("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading, refetch } = trpc.proposals.list.useQuery({
    status: status === "all" ? "all" : status,
    targetType: targetType || undefined,
    workspaceId: workspaceId ?? undefined,
    limit: 100,
  });

  const approveMutation = trpc.proposals.approve.useMutation({
    onSuccess: () => {
      refetch();
      showSuccessNotification({ message: "Proposal approved" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const rejectMutation = trpc.proposals.reject.useMutation({
    onSuccess: () => {
      refetch();
      showSuccessNotification({ message: "Proposal rejected" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const proposals = data?.proposals ?? [];

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (selected.size === proposals.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(proposals.map((p) => p.id)));
    }
  }

  async function bulkApprove() {
    for (const id of selected) {
      await approveMutation.mutateAsync({ proposalId: id });
    }
    setSelected(new Set());
  }

  async function bulkReject() {
    for (const id of selected) {
      await rejectMutation.mutateAsync({ proposalId: id });
    }
    setSelected(new Set());
  }

  const allSelected =
    selected.size === proposals.length && proposals.length > 0;
  const someSelected = selected.size > 0 && selected.size < proposals.length;

  return (
    <div style={{ padding: spacing[6] }}>
      <div className="mb-6 flex items-start gap-3">
        <IconCheckbox size={22} color={colors.eventTypes.created} />
        <div>
          <Text className="text-xl font-bold">Proposals</Text>
          <Text className="text-sm text-default-500">
            Review and govern AI-proposed changes.
          </Text>
        </div>
      </div>

      <div
        className="mb-4 flex flex-wrap gap-4"
        style={{ marginBottom: spacing[4] }}
      >
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-default-600">Status</label>
          <select
            className={inputClass}
            style={{ width: 150 }}
            value={status}
            onChange={(e) =>
              setStatus((e.target.value as ProposalStatus) || "pending")
            }
          >
            <option value="pending">Pending</option>
            <option value="validated">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-default-600">
            Target Type
          </label>
          <select
            className={inputClass}
            style={{ width: 160 }}
            value={targetType}
            onChange={(e) =>
              setTargetType((e.target.value as TargetType | "") || "")
            }
          >
            <option value="">All types</option>
            <option value="entity">Entity</option>
            <option value="document">Document</option>
            <option value="view">View</option>
            <option value="whiteboard">Whiteboard</option>
          </select>
        </div>
      </div>

      {selected.size > 0 ? (
        <div
          className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border p-3"
          style={{
            marginBottom: spacing[4],
            backgroundColor: `${colors.eventTypes.created}10`,
            borderColor: `${colors.eventTypes.created}30`,
          }}
        >
          <Text className="text-sm font-medium">{selected.size} selected</Text>
          <Button
            size="sm"
            variant="ghost"
            className="text-success"
            onPress={bulkApprove}
            isDisabled={approveMutation.isPending}
          >
            {approveMutation.isPending ? (
              <Spinner size="sm" color="current" />
            ) : (
              <span className="inline-flex items-center gap-1">
                <IconCheck size={14} />
                Approve All
              </span>
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            onPress={bulkReject}
            isDisabled={rejectMutation.isPending}
          >
            {rejectMutation.isPending ? (
              <Spinner size="sm" color="current" />
            ) : (
              <span className="inline-flex items-center gap-1">
                <IconX size={14} />
                Reject All
              </span>
            )}
          </Button>
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" color="accent" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-divider">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-divider bg-default-50/80">
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-divider"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={selectAll}
                    aria-label="Select all"
                  />
                </th>
                <th className="w-8 px-1 py-2" />
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Age</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => (
                <Fragment key={p.id}>
                  <tr className="border-b border-divider/60 hover:bg-default-100/40">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-divider"
                        checked={selected.has(p.id)}
                        onChange={() => toggleSelect(p.id)}
                        aria-label={`Select ${p.id}`}
                      />
                    </td>
                    <td className="px-1 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        aria-label={expanded.has(p.id) ? "Collapse" : "Expand"}
                        onPress={() => toggleExpand(p.id)}
                      >
                        {expanded.has(p.id) ? (
                          <IconChevronDown size={14} />
                        ) : (
                          <IconChevronRight size={14} />
                        )}
                      </Button>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-0.5">
                        <Chip size="sm" variant="soft" color="default">
                          {p.targetType}
                        </Chip>
                        <span
                          className="text-xs text-default-500"
                          style={{ fontFamily: typography.fontFamily.mono }}
                        >
                          {p.targetId.slice(0, 12)}…
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Text className="text-sm">{p.proposalType}</Text>
                    </td>
                    <td className="px-3 py-2">
                      <Chip
                        size="sm"
                        variant="soft"
                        color={STATUS_COLORS[p.status] ?? "default"}
                      >
                        {p.status}
                      </Chip>
                    </td>
                    <td className="px-3 py-2">
                      <Text className="text-sm text-default-500">
                        {timeSince(p.createdAt)}
                      </Text>
                    </td>
                    <td className="px-3 py-2">
                      {p.status === "pending" ? (
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            isIconOnly
                            className="text-success"
                            isDisabled={approveMutation.isPending}
                            aria-label="Approve"
                            onPress={() =>
                              approveMutation.mutate({ proposalId: p.id })
                            }
                          >
                            <IconCheck size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            isIconOnly
                            className="text-danger"
                            isDisabled={rejectMutation.isPending}
                            aria-label="Reject"
                            onPress={() =>
                              rejectMutation.mutate({ proposalId: p.id })
                            }
                          >
                            <IconX size={14} />
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                  {expanded.has(p.id) ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="border-b border-divider px-3 py-3"
                        style={{
                          backgroundColor: colors.background.secondary,
                        }}
                      >
                        <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-default-500">
                          Proposal data
                        </Text>
                        <pre
                          className="max-h-[200px] overflow-y-auto whitespace-pre-wrap rounded-md border border-divider bg-default-50 p-3 text-xs"
                          style={{ fontFamily: typography.fontFamily.mono }}
                        >
                          {JSON.stringify(p.data, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
              {proposals.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center">
                    <Text className="text-default-500">
                      No proposals found.
                    </Text>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import {
  Text,
  Badge,
  Button,
  Select,
  Table,
  ActionIcon,
  Group,
  Loader,
  Code,
  Checkbox,
  Stack,
} from "@mantine/core";
import {
  IconCheckbox,
  IconCheck,
  IconX,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing, typography } from "../../theme/tokens";

const STATUS_COLORS: Record<string, string> = {
  pending: "yellow",
  validated: "green",
  rejected: "red",
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
  const [status, setStatus] = useState<ProposalStatus>("pending");
  const [targetType, setTargetType] = useState<TargetType | "">("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading, refetch } = trpc.proposals.list.useQuery({
    status: status === "all" ? "all" : status,
    targetType: targetType || undefined,
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

  return (
    <div style={{ padding: spacing[6] }}>
      {/* Header */}
      <Group mb={spacing[6]}>
        <IconCheckbox size={22} color={colors.eventTypes.created} />
        <div>
          <Text size="xl" fw={700}>
            Proposals
          </Text>
          <Text size="sm" c="dimmed">
            Review and govern AI-proposed changes.
          </Text>
        </div>
      </Group>

      {/* Filters */}
      <Group mb={spacing[4]}>
        <Select
          label="Status"
          data={[
            { value: "pending", label: "Pending" },
            { value: "validated", label: "Approved" },
            { value: "rejected", label: "Rejected" },
            { value: "all", label: "All" },
          ]}
          value={status}
          onChange={(v) => setStatus((v as ProposalStatus) ?? "pending")}
          style={{ width: 150 }}
        />
        <Select
          label="Target Type"
          data={[
            { value: "", label: "All types" },
            { value: "entity", label: "Entity" },
            { value: "document", label: "Document" },
            { value: "view", label: "View" },
            { value: "whiteboard", label: "Whiteboard" },
          ]}
          value={targetType}
          onChange={(v) => setTargetType((v as TargetType | "") ?? "")}
          style={{ width: 160 }}
        />
      </Group>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <Group
          mb={spacing[4]}
          p={spacing[3]}
          style={{
            backgroundColor: `${colors.eventTypes.created}10`,
            borderRadius: 8,
            border: `1px solid ${colors.eventTypes.created}30`,
          }}
        >
          <Text size="sm" fw={500}>
            {selected.size} selected
          </Text>
          <Button
            size="xs"
            leftSection={<IconCheck size={14} />}
            color="green"
            onClick={bulkApprove}
            loading={approveMutation.isPending}
          >
            Approve All
          </Button>
          <Button
            size="xs"
            leftSection={<IconX size={14} />}
            color="red"
            onClick={bulkReject}
            loading={rejectMutation.isPending}
          >
            Reject All
          </Button>
        </Group>
      )}

      {isLoading ? (
        <Loader />
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: 40 }}>
                <Checkbox
                  checked={
                    selected.size === proposals.length && proposals.length > 0
                  }
                  indeterminate={
                    selected.size > 0 && selected.size < proposals.length
                  }
                  onChange={selectAll}
                />
              </Table.Th>
              <Table.Th></Table.Th>
              <Table.Th>Target</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Age</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {proposals.map((p) => (
              <>
                <Table.Tr key={p.id}>
                  <Table.Td>
                    <Checkbox
                      checked={selected.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      onClick={() => toggleExpand(p.id)}
                    >
                      {expanded.has(p.id) ? (
                        <IconChevronDown size={14} />
                      ) : (
                        <IconChevronRight size={14} />
                      )}
                    </ActionIcon>
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      <Badge size="xs" variant="dot" color="gray">
                        {p.targetType}
                      </Badge>
                      <Text
                        size="xs"
                        c="dimmed"
                        style={{ fontFamily: typography.fontFamily.mono }}
                      >
                        {p.targetId.slice(0, 12)}…
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{p.proposalType}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="xs" color={STATUS_COLORS[p.status] ?? "gray"}>
                      {p.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {timeSince(p.createdAt)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {p.status === "pending" && (
                      <Group gap={4}>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="green"
                          loading={approveMutation.isPending}
                          onClick={() =>
                            approveMutation.mutate({ proposalId: p.id })
                          }
                        >
                          <IconCheck size={14} />
                        </ActionIcon>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="red"
                          loading={rejectMutation.isPending}
                          onClick={() =>
                            rejectMutation.mutate({ proposalId: p.id })
                          }
                        >
                          <IconX size={14} />
                        </ActionIcon>
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
                {expanded.has(p.id) && (
                  <Table.Tr>
                    <Table.Td
                      colSpan={7}
                      style={{ backgroundColor: colors.background.secondary }}
                    >
                      <div style={{ padding: spacing[3] }}>
                        <Text size="xs" fw={600} c="dimmed" mb={spacing[1]}>
                          PROPOSAL DATA
                        </Text>
                        <Code
                          block
                          style={{
                            fontFamily: typography.fontFamily.mono,
                            fontSize: typography.fontSize.xs,
                            maxHeight: 200,
                            overflowY: "auto",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {JSON.stringify(p.data, null, 2)}
                        </Code>
                      </div>
                    </Table.Td>
                  </Table.Tr>
                )}
              </>
            ))}
            {proposals.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <Text c="dimmed" ta="center" py={spacing[6]}>
                    No proposals found.
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      )}
    </div>
  );
}

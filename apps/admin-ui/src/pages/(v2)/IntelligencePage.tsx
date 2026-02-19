import { useState } from "react";
import {
  Text,
  Badge,
  Tabs,
  Table,
  ActionIcon,
  Tooltip,
  Group,
  Loader,
  Code,
  Anchor,
  Stack,
} from "@mantine/core";
import {
  IconTerminal2,
  IconTrash,
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
} from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { trpc } from "../../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing, typography } from "../../theme/tokens";

const OUTPUT_MODE_COLORS: Record<string, string> = {
  text: "blue",
  proposal: "orange",
  view: "green",
};

const PERMISSIONS_COLORS: Record<string, string> = {
  read_only: "gray",
  propose_writes: "violet",
};

const STATUS_COLORS: Record<string, string> = {
  completed: "green",
  running: "blue",
  failed: "red",
};

function CommandRow({
  cmd,
  onDelete,
  deleting,
}: {
  cmd: {
    id: string;
    title: string;
    outputMode: "text" | "proposal" | "view";
    permissionsProfile: "read_only" | "propose_writes";
    sharedScope: "workspace" | "user";
    promptTemplate: string;
    derivedInputs: unknown[] | null;
  };
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <Table.Tr>
        <Table.Td>
          <Group gap={4}>
            <ActionIcon
              size="xs"
              variant="subtle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <IconChevronDown size={14} />
              ) : (
                <IconChevronRight size={14} />
              )}
            </ActionIcon>
            <Text size="sm" fw={500}>
              {cmd.title}
            </Text>
          </Group>
        </Table.Td>
        <Table.Td>
          <Badge size="xs" color={OUTPUT_MODE_COLORS[cmd.outputMode] ?? "gray"}>
            {cmd.outputMode}
          </Badge>
        </Table.Td>
        <Table.Td>
          <Badge
            size="xs"
            color={PERMISSIONS_COLORS[cmd.permissionsProfile] ?? "gray"}
          >
            {cmd.permissionsProfile}
          </Badge>
        </Table.Td>
        <Table.Td>
          <Badge size="xs" variant="outline" color="gray">
            {cmd.sharedScope}
          </Badge>
        </Table.Td>
        <Table.Td>
          <Tooltip label="Delete command">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              loading={deleting}
              onClick={() => onDelete(cmd.id)}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        </Table.Td>
      </Table.Tr>
      {expanded && (
        <Table.Tr>
          <Table.Td
            colSpan={5}
            style={{ backgroundColor: colors.background.secondary }}
          >
            <Stack gap={spacing[3]} p={spacing[3]}>
              <div>
                <Text size="xs" fw={600} c="dimmed" mb={spacing[1]}>
                  PROMPT TEMPLATE
                </Text>
                <Code
                  block
                  style={{
                    fontFamily: typography.fontFamily.mono,
                    fontSize: typography.fontSize.xs,
                    whiteSpace: "pre-wrap",
                    maxHeight: 200,
                    overflowY: "auto",
                  }}
                >
                  {cmd.promptTemplate}
                </Code>
              </div>
              {cmd.derivedInputs && cmd.derivedInputs.length > 0 && (
                <div>
                  <Text size="xs" fw={600} c="dimmed" mb={spacing[1]}>
                    DERIVED INPUTS
                  </Text>
                  <Code block style={{ fontSize: typography.fontSize.xs }}>
                    {JSON.stringify(cmd.derivedInputs, null, 2)}
                  </Code>
                </div>
              )}
            </Stack>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

export default function IntelligencePage() {
  const { data: commandsData, isLoading: commandsLoading, refetch: refetchCommands } =
    trpc.intelligence.listCommands.useQuery({});

  const { data: runsData, isLoading: runsLoading } =
    trpc.intelligence.listRuns.useQuery({});

  const deletingIds = new Set<string>();

  const deleteCommandMutation = trpc.intelligence.deleteCommand.useMutation({
    onSuccess: () => {
      refetchCommands();
      showSuccessNotification({ message: "Command deleted" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const commands = commandsData?.commands ?? [];
  const runs = runsData?.runs ?? [];

  function formatDuration(start: Date, end: Date | null) {
    if (!end) return "—";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  return (
    <div style={{ padding: spacing[6] }}>
      {/* Header */}
      <Group mb={spacing[6]}>
        <IconTerminal2 size={22} color={colors.eventTypes.created} />
        <div>
          <Text size="xl" fw={700}>
            Intelligence
          </Text>
          <Text size="sm" c="dimmed">
            AI commands and execution history.
          </Text>
        </div>
      </Group>

      <Tabs defaultValue="commands">
        <Tabs.List mb={spacing[4]}>
          <Tabs.Tab value="commands">
            Commands
            <Badge size="xs" ml="xs" color="violet" variant="light">
              {commands.length}
            </Badge>
          </Tabs.Tab>
          <Tabs.Tab value="history">Execution History</Tabs.Tab>
        </Tabs.List>

        {/* Commands Tab */}
        <Tabs.Panel value="commands">
          {commandsLoading ? (
            <Loader />
          ) : (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Title</Table.Th>
                  <Table.Th>Output Mode</Table.Th>
                  <Table.Th>Permissions</Table.Th>
                  <Table.Th>Scope</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {commands.map((cmd) => (
                  <CommandRow
                    key={cmd.id}
                    cmd={cmd}
                    onDelete={(id) => deleteCommandMutation.mutate({ id })}
                    deleting={deleteCommandMutation.isPending}
                  />
                ))}
                {commands.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <Text c="dimmed" ta="center" py={spacing[6]}>
                        No commands found.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          )}
        </Tabs.Panel>

        {/* Execution History Tab */}
        <Tabs.Panel value="history">
          {runsLoading ? (
            <Loader />
          ) : (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Run ID</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Duration</Table.Th>
                  <Table.Th>Started</Table.Th>
                  <Table.Th>Thread</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {runs.map((run) => (
                  <Table.Tr key={run.id}>
                    <Table.Td>
                      <Text
                        size="xs"
                        style={{ fontFamily: typography.fontFamily.mono }}
                        c="dimmed"
                      >
                        {run.id.slice(0, 8)}…
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="xs"
                        color={STATUS_COLORS[run.status] ?? "gray"}
                      >
                        {run.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {formatDuration(run.startedAt, run.completedAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {new Date(run.startedAt).toLocaleString()}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Anchor
                        component={Link}
                        to={`/events?threadId=${run.threadId}`}
                        size="xs"
                      >
                        <Group gap={4}>
                          <IconExternalLink size={12} />
                          Trace
                        </Group>
                      </Anchor>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {runs.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <Text c="dimmed" ta="center" py={spacing[6]}>
                        No runs found.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          )}
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}

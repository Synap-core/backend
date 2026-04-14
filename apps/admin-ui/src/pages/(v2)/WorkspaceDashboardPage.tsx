import { useNavigate, Link } from "react-router-dom";
import {
  Title,
  Text,
  Stack,
  Card,
  Group,
  Button,
  Badge,
  Table,
  Loader,
  ThemeIcon,
} from "@mantine/core";
import {
  IconUsers,
  IconRobot,
  IconCheckbox,
  IconSettings,
  IconPlus,
  IconArrowRight,
  IconBuildingCommunity,
  IconBrain,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";
import { colors, spacing, borderRadius, typography } from "../../theme/tokens";

function timeSince(date: Date | string) {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const WORKSPACE_TYPE_COLORS: Record<string, string> = {
  personal: "blue",
  team: "green",
  enterprise: "violet",
};

const ROLE_COLORS: Record<string, string> = {
  owner: "violet",
  admin: "orange",
  editor: "blue",
  viewer: "gray",
};

const PROPOSAL_STATUS_COLORS: Record<string, string> = {
  pending: "yellow",
  validated: "green",
  rejected: "red",
};

export default function WorkspaceDashboardPage() {
  const navigate = useNavigate();
  const { workspaceId, workspaceName } = useWorkspace();

  const { data: workspace, isLoading: wsLoading } =
    trpc.workspaces.get.useQuery(
      { id: workspaceId! },
      { enabled: !!workspaceId }
    );

  const { data: members, isLoading: membersLoading } =
    trpc.workspaces.listMembers.useQuery(
      { workspaceId: workspaceId! },
      { enabled: !!workspaceId }
    );

  const { data: agents, isLoading: agentsLoading } =
    trpc.agentUsers.list.useQuery(
      { workspaceId: workspaceId! },
      { enabled: !!workspaceId }
    );

  const { data: proposalsData, isLoading: proposalsLoading } =
    trpc.proposals.list.useQuery(
      { status: "pending", limit: 5 },
      { enabled: !!workspaceId }
    );

  const memberCount = members?.length ?? 0;
  const agentCount = agents?.length ?? 0;
  const pendingProposals = proposalsData?.proposals ?? [];
  const isLoading = wsLoading || membersLoading || agentsLoading;

  if (!workspaceId) {
    return (
      <div style={{ padding: spacing[8] }}>
        <Text c="dimmed">No workspace selected.</Text>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", padding: spacing[8] }}>
      <Stack gap={spacing[6]}>
        {/* Header */}
        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap={spacing[2]} mb={spacing[1]}>
              <IconBuildingCommunity
                size={20}
                color={colors.eventTypes.created}
              />
              <Title
                order={1}
                style={{
                  fontFamily: typography.fontFamily.sans,
                  color: colors.text.primary,
                }}
              >
                {workspaceName ?? "Workspace"}
              </Title>
              {workspace && (
                <Badge
                  size="sm"
                  variant="light"
                  color={WORKSPACE_TYPE_COLORS[workspace.type] ?? "gray"}
                >
                  {workspace.type}
                </Badge>
              )}
              {workspace?.role && (
                <Badge
                  size="sm"
                  variant="outline"
                  color={ROLE_COLORS[workspace.role] ?? "gray"}
                >
                  {workspace.role}
                </Badge>
              )}
            </Group>
            <Text size="sm" style={{ color: colors.text.secondary }}>
              Workspace overview — members, agents, and pending actions
            </Text>
          </div>
          <Button
            component={Link}
            to={`/workspaces/${workspaceId}`}
            variant="light"
            leftSection={<IconSettings size={16} />}
            rightSection={<IconArrowRight size={14} />}
            color="violet"
          >
            Manage Workspace
          </Button>
        </Group>

        {/* Stats row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: spacing[4],
          }}
        >
          {/* Members */}
          <Card
            padding={spacing[4]}
            radius={borderRadius.lg}
            style={{
              border: `1px solid ${colors.border.default}`,
              backgroundColor: colors.background.primary,
              cursor: "pointer",
            }}
            onClick={() => navigate(`/workspaces/${workspaceId}`)}
          >
            <Group justify="space-between" mb={spacing[2]}>
              <Text size="sm" fw={500} c={colors.text.secondary}>
                Members
              </Text>
              <ThemeIcon size={32} radius="md" color="blue" variant="light">
                <IconUsers size={16} />
              </ThemeIcon>
            </Group>
            {membersLoading ? (
              <Loader size="sm" />
            ) : (
              <>
                <Text size="2rem" fw={700} c={colors.text.primary}>
                  {memberCount}
                </Text>
                <Text size="xs" c={colors.text.tertiary} mt={spacing[1]}>
                  active members
                </Text>
              </>
            )}
          </Card>

          {/* Agents */}
          <Card
            padding={spacing[4]}
            radius={borderRadius.lg}
            style={{
              border: `1px solid ${colors.border.default}`,
              backgroundColor: colors.background.primary,
              cursor: "pointer",
            }}
            onClick={() => navigate(`/workspaces/${workspaceId}`)}
          >
            <Group justify="space-between" mb={spacing[2]}>
              <Text size="sm" fw={500} c={colors.text.secondary}>
                Agents
              </Text>
              <ThemeIcon size={32} radius="md" color="orange" variant="light">
                <IconRobot size={16} />
              </ThemeIcon>
            </Group>
            {agentsLoading ? (
              <Loader size="sm" />
            ) : (
              <>
                <Text size="2rem" fw={700} c={colors.text.primary}>
                  {agentCount}
                </Text>
                <Text size="xs" c={colors.text.tertiary} mt={spacing[1]}>
                  AI agents
                </Text>
              </>
            )}
          </Card>

          {/* Pending Proposals */}
          <Card
            padding={spacing[4]}
            radius={borderRadius.lg}
            style={{
              border: `1px solid ${colors.border.default}`,
              backgroundColor: colors.background.primary,
              cursor: "pointer",
            }}
            onClick={() => navigate("/proposals")}
          >
            <Group justify="space-between" mb={spacing[2]}>
              <Text size="sm" fw={500} c={colors.text.secondary}>
                Pending
              </Text>
              <ThemeIcon size={32} radius="md" color="yellow" variant="light">
                <IconCheckbox size={16} />
              </ThemeIcon>
            </Group>
            {proposalsLoading ? (
              <Loader size="sm" />
            ) : (
              <>
                <Text size="2rem" fw={700} c={colors.text.primary}>
                  {pendingProposals.length}
                </Text>
                <Text size="xs" c={colors.text.tertiary} mt={spacing[1]}>
                  proposals to review
                </Text>
              </>
            )}
          </Card>

          {/* Intelligence */}
          <Card
            padding={spacing[4]}
            radius={borderRadius.lg}
            style={{
              border: `1px solid ${colors.border.default}`,
              backgroundColor: colors.background.primary,
              cursor: "pointer",
            }}
            onClick={() => navigate("/intelligence")}
          >
            <Group justify="space-between" mb={spacing[2]}>
              <Text size="sm" fw={500} c={colors.text.secondary}>
                Intelligence
              </Text>
              <ThemeIcon size={32} radius="md" color="violet" variant="light">
                <IconBrain size={16} />
              </ThemeIcon>
            </Group>
            {isLoading ? (
              <Loader size="sm" />
            ) : (
              <>
                <Text
                  size="sm"
                  fw={600}
                  c={
                    workspace?.settings?.intelligenceServiceId
                      ? colors.semantic.success
                      : colors.text.tertiary
                  }
                >
                  {workspace?.settings?.intelligenceServiceId
                    ? "Connected"
                    : "Not connected"}
                </Text>
                <Text size="xs" c={colors.text.tertiary} mt={spacing[1]}>
                  AI service
                </Text>
              </>
            )}
          </Card>
        </div>

        {/* Quick Actions */}
        <Card
          padding={spacing[4]}
          radius={borderRadius.lg}
          style={{
            border: `1px solid ${colors.border.default}`,
            backgroundColor: colors.background.primary,
          }}
        >
          <Text size="sm" fw={600} mb={spacing[3]} c={colors.text.primary}>
            Quick Actions
          </Text>
          <Group gap={spacing[3]} wrap="wrap">
            <Button
              variant="light"
              size="sm"
              leftSection={<IconPlus size={16} />}
              component={Link}
              to={`/workspaces/${workspaceId}`}
              color="blue"
            >
              Invite Member
            </Button>
            <Button
              variant="light"
              size="sm"
              leftSection={<IconCheckbox size={16} />}
              onClick={() => navigate("/proposals")}
              color="yellow"
            >
              Review Proposals
            </Button>
            <Button
              variant="light"
              size="sm"
              leftSection={<IconRobot size={16} />}
              component={Link}
              to={`/workspaces/${workspaceId}`}
              color="orange"
            >
              Manage Agents
            </Button>
            <Button
              variant="light"
              size="sm"
              leftSection={<IconBrain size={16} />}
              onClick={() => navigate("/intelligence")}
              color="violet"
            >
              Configure Intelligence
            </Button>
          </Group>
        </Card>

        {/* Pending Proposals */}
        <Card
          padding={spacing[4]}
          radius={borderRadius.lg}
          style={{
            border: `1px solid ${colors.border.default}`,
            backgroundColor: colors.background.primary,
          }}
        >
          <Group justify="space-between" mb={spacing[3]}>
            <Text size="sm" fw={600} c={colors.text.primary}>
              Pending Proposals
            </Text>
            <Button
              variant="subtle"
              size="xs"
              rightSection={<IconArrowRight size={12} />}
              onClick={() => navigate("/proposals")}
            >
              View all
            </Button>
          </Group>

          {proposalsLoading ? (
            <Group justify="center" py={spacing[4]}>
              <Loader size="sm" />
            </Group>
          ) : pendingProposals.length === 0 ? (
            <Text
              size="sm"
              c={colors.text.tertiary}
              ta="center"
              py={spacing[4]}
            >
              No pending proposals
            </Text>
          ) : (
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Action</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>When</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {pendingProposals.map((p) => (
                  <Table.Tr key={p.id}>
                    <Table.Td>
                      <Text size="sm" fw={500} lineClamp={1}>
                        {(
                          p.request as { operation?: string } | null | undefined
                        )?.operation ?? p.id}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" color="gray">
                        {p.targetType}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="xs"
                        variant="light"
                        color={PROPOSAL_STATUS_COLORS[p.status] ?? "gray"}
                      >
                        {p.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {timeSince(p.createdAt)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>
      </Stack>
    </div>
  );
}

import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  Button,
  Text,
  Badge,
  Modal,
  TextInput,
  Select,
  Tabs,
  Table,
  ActionIcon,
  Group,
  Stack,
  Loader,
  Switch,
  Anchor,
  Textarea,
  TagsInput,
  Card,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconPlus,
  IconTrash,
  IconBuildingCommunity,
  IconRobot,
  IconPlug,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing, typography, borderRadius } from "../../theme/tokens";

const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
  { value: "admin", label: "Admin" },
];

const ROLE_COLORS: Record<string, string> = {
  owner: "violet",
  admin: "orange",
  editor: "blue",
  viewer: "gray",
};

const AGENT_TYPE_OPTIONS = [
  { value: "assistant", label: "Assistant" },
  { value: "researcher", label: "Researcher" },
  { value: "writer", label: "Writer" },
  { value: "analyst", label: "Analyst" },
  { value: "custom", label: "Custom" },
];

export default function WorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId: contextWorkspaceId } = useWorkspace();
  const workspaceId = id ?? contextWorkspaceId!;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "editor" | "admin">(
    "editor"
  );

  // Agent creation state
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentType, setAgentType] = useState("assistant");
  const [agentRole, setAgentRole] = useState<"viewer" | "editor" | "admin">(
    "editor"
  );
  const [agentDescription, setAgentDescription] = useState("");
  const [agentCapabilities, setAgentCapabilities] = useState<string[]>([]);

  const {
    data: workspace,
    isLoading: wsLoading,
    refetch: refetchWs,
  } = trpc.workspaces.get.useQuery({ id: workspaceId });

  const {
    data: members,
    isLoading: membersLoading,
    refetch: refetchMembers,
  } = trpc.workspaces.listMembers.useQuery({ workspaceId });

  const {
    data: invites,
    isLoading: invitesLoading,
    refetch: refetchInvites,
  } = trpc.workspaces.listInvites.useQuery({ workspaceId });

  const {
    data: agents,
    isLoading: agentsLoading,
    refetch: refetchAgents,
  } = trpc.agentUsers.list.useQuery({ workspaceId });

  const removeMemberMutation = trpc.workspaces.removeMember.useMutation({
    onSuccess: () => {
      refetchMembers();
      showSuccessNotification({ message: "Member removed" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const updateRoleMutation = trpc.workspaces.updateMemberRole.useMutation({
    onSuccess: () => {
      refetchMembers();
      showSuccessNotification({ message: "Role updated" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const createInviteMutation = trpc.workspaces.createInvite.useMutation({
    onSuccess: () => {
      refetchInvites();
      setInviteOpen(false);
      setInviteEmail("");
      showSuccessNotification({ message: "Invitation sent" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const revokeInviteMutation = trpc.workspaces.revokeInvite.useMutation({
    onSuccess: () => {
      refetchInvites();
      showSuccessNotification({ message: "Invitation revoked" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const updateMutation = trpc.workspaces.update.useMutation({
    onSuccess: () => {
      refetchWs();
      showSuccessNotification({ message: "Settings saved" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const createAgentMutation = trpc.agentUsers.create.useMutation({
    onSuccess: () => {
      refetchAgents();
      setAgentModalOpen(false);
      resetAgentForm();
      showSuccessNotification({ message: "AI agent created" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const removeAgentMutation = trpc.agentUsers.remove.useMutation({
    onSuccess: () => {
      refetchAgents();
      showSuccessNotification({ message: "AI agent removed" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  function resetAgentForm() {
    setAgentName("");
    setAgentType("assistant");
    setAgentRole("editor");
    setAgentDescription("");
    setAgentCapabilities([]);
  }

  function handleSettingChange(key: string, value: unknown) {
    if (!workspace) return;
    updateMutation.mutate({
      id: workspaceId,
      settings: {
        ...(workspace.settings as Record<string, unknown>),
        [key]: value,
      },
    });
  }

  if (wsLoading) {
    return (
      <div style={{ padding: spacing[6] }}>
        <Loader />
      </div>
    );
  }

  if (!workspace) {
    return (
      <div style={{ padding: spacing[6] }}>
        <Text c="dimmed">Workspace not found.</Text>
      </div>
    );
  }

  const settings = (workspace.settings as Record<string, unknown>) ?? {};

  return (
    <div style={{ padding: spacing[6] }}>
      {/* Back + header */}
      <Group mb={spacing[6]}>
        <Anchor component={Link} to="/workspaces" c="dimmed" size="sm">
          <Group gap={4}>
            <IconArrowLeft size={14} />
            Workspaces
          </Group>
        </Anchor>
      </Group>

      <Group mb={spacing[6]}>
        <IconBuildingCommunity size={22} color={colors.eventTypes.created} />
        <div>
          <Text size="xl" fw={700}>
            {workspace.name}
          </Text>
          <Group gap="xs">
            <Badge size="xs" variant="light" color="gray">
              {workspace.type}
            </Badge>
            <Badge
              size="xs"
              variant="outline"
              color={ROLE_COLORS[workspace.role] ?? "gray"}
            >
              {workspace.role}
            </Badge>
          </Group>
        </div>
      </Group>

      <Tabs defaultValue="members">
        <Tabs.List mb={spacing[4]}>
          <Tabs.Tab value="members">Members</Tabs.Tab>
          <Tabs.Tab value="agents">
            <Group gap={4}>
              <IconRobot size={14} />
              AI Agents
            </Group>
          </Tabs.Tab>
          <Tabs.Tab value="invitations">Invitations</Tabs.Tab>
          <Tabs.Tab value="settings">Settings</Tabs.Tab>
          <Tabs.Tab value="intelligence">Intelligence</Tabs.Tab>
          <Tabs.Tab value="services">
            <Group gap={4}>
              <IconPlug size={14} />
              Services
            </Group>
          </Tabs.Tab>
        </Tabs.List>

        {/* Members Tab */}
        <Tabs.Panel value="members">
          <Group justify="space-between" mb={spacing[4]}>
            <Text fw={600}>Members</Text>
            <Button
              leftSection={<IconPlus size={16} />}
              size="sm"
              onClick={() => setInviteOpen(true)}
              color="violet"
            >
              Invite Member
            </Button>
          </Group>
          {membersLoading ? (
            <Loader />
          ) : (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>User</Table.Th>
                  <Table.Th>Email</Table.Th>
                  <Table.Th>Role</Table.Th>
                  <Table.Th>Joined</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {members?.map((m) => (
                  <Table.Tr key={m.id}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {m.user.name ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {m.user.email}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        data={ROLE_OPTIONS}
                        value={m.role}
                        onChange={(role) => {
                          if (role && role !== m.role) {
                            updateRoleMutation.mutate({
                              workspaceId,
                              userId: m.userId,
                              role: role as "admin" | "editor" | "viewer",
                            });
                          }
                        }}
                        style={{ width: 120 }}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {new Date(m.joinedAt).toLocaleDateString()}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          removeMemberMutation.mutate({
                            workspaceId,
                            userId: m.userId,
                          })
                        }
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Tabs.Panel>

        {/* AI Agents Tab */}
        <Tabs.Panel value="agents">
          <Group justify="space-between" mb={spacing[4]}>
            <Text fw={600}>AI Agents</Text>
            <Button
              leftSection={<IconPlus size={16} />}
              size="sm"
              onClick={() => setAgentModalOpen(true)}
              color="orange"
            >
              Create Agent
            </Button>
          </Group>
          {agentsLoading ? (
            <Loader />
          ) : !agents || agents.length === 0 ? (
            <Card
              padding={spacing[6]}
              radius={borderRadius.lg}
              style={{
                border: `1px dashed ${colors.border.default}`,
                backgroundColor: colors.background.secondary,
                textAlign: "center",
              }}
            >
              <IconRobot
                size={40}
                color={colors.text.tertiary}
                style={{ marginBottom: spacing[2] }}
              />
              <Text size="sm" c={colors.text.secondary} mb={spacing[2]}>
                No AI agents in this workspace yet.
              </Text>
              <Text size="xs" c={colors.text.tertiary}>
                Create an agent to automate tasks with workspace-scoped
                permissions.
              </Text>
            </Card>
          ) : (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Role</Table.Th>
                  <Table.Th>Capabilities</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {agents.map((agent) => (
                  <Table.Tr key={agent.id}>
                    <Table.Td>
                      <Group gap={spacing[2]}>
                        <IconRobot size={16} color={colors.eventTypes.ai} />
                        <Text size="sm" fw={500}>
                          {agent.name}
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="light" color="orange">
                        {agent.agentMetadata?.agentType || "—"}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="sm"
                        variant="outline"
                        color={ROLE_COLORS[agent.role] ?? "gray"}
                      >
                        {agent.role}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {agent.agentMetadata?.capabilities
                          ?.slice(0, 3)
                          .map((cap) => (
                            <Badge
                              key={cap}
                              size="xs"
                              variant="light"
                              color="cyan"
                            >
                              {cap}
                            </Badge>
                          ))}
                        {(agent.agentMetadata?.capabilities?.length ?? 0) >
                          3 && (
                          <Badge size="xs" variant="light" color="gray">
                            +
                            {(agent.agentMetadata?.capabilities?.length ?? 0) -
                              3}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          removeAgentMutation.mutate({
                            workspaceId,
                            agentUserId: agent.id,
                          })
                        }
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Tabs.Panel>

        {/* Invitations Tab */}
        <Tabs.Panel value="invitations">
          <Text fw={600} mb={spacing[4]}>
            Pending Invitations
          </Text>
          {invitesLoading ? (
            <Loader />
          ) : (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Email</Table.Th>
                  <Table.Th>Role</Table.Th>
                  <Table.Th>Expires</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {invites?.map((inv) => (
                  <Table.Tr key={inv.id}>
                    <Table.Td>
                      <Text size="sm">{inv.email}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" color={ROLE_COLORS[inv.role] ?? "gray"}>
                        {inv.role}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {new Date(inv.expiresAt).toLocaleDateString()}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          revokeInviteMutation.mutate({ id: inv.id })
                        }
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {invites?.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Text c="dimmed" ta="center" py={spacing[4]}>
                        No pending invitations.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          )}
        </Tabs.Panel>

        {/* Settings Tab */}
        <Tabs.Panel value="settings">
          <Stack gap={spacing[5]} maw={480}>
            <Text fw={600}>Workspace Settings</Text>
            <Switch
              label="AI Enabled"
              description="Allow AI features in this workspace"
              checked={Boolean(settings.aiEnabled)}
              onChange={(e) =>
                handleSettingChange("aiEnabled", e.currentTarget.checked)
              }
            />
            <Switch
              label="External Sharing"
              description="Allow sharing content outside the workspace"
              checked={Boolean(settings.externalSharing)}
              onChange={(e) =>
                handleSettingChange("externalSharing", e.currentTarget.checked)
              }
            />
            <Switch
              label="AI Auto-Approve"
              description="Automatically approve AI-proposed changes"
              checked={Boolean(
                (settings.aiGovernance as Record<string, unknown>)?.autoApprove
              )}
              onChange={(e) =>
                handleSettingChange("aiGovernance", {
                  ...((settings.aiGovernance as Record<string, unknown>) ?? {}),
                  autoApprove: e.currentTarget.checked,
                })
              }
            />
          </Stack>
        </Tabs.Panel>

        {/* Services Tab */}
        <Tabs.Panel value="services">
          <Stack gap={spacing[3]} maw={560}>
            <Text fw={600}>External Agent Services</Text>
            <Text size="sm" c="dimmed">
              Provision Docker-based agent containers (OpenClaw, ZeroClaw, …)
              that connect to this workspace via Hub Protocol.
            </Text>
            <Button
              component={Link}
              to="/services"
              leftSection={<IconPlug size={16} />}
              variant="light"
              color="teal"
              w="fit-content"
            >
              Manage Services
            </Button>
          </Stack>
        </Tabs.Panel>

        {/* Intelligence Tab */}
        <Tabs.Panel value="intelligence">
          <Stack gap={spacing[4]} maw={480}>
            <Text fw={600}>Intelligence Service</Text>
            <div>
              <Text size="sm" c="dimmed" mb={spacing[2]}>
                Connected Service ID
              </Text>
              <Text
                size="sm"
                style={{
                  fontFamily: typography.fontFamily.mono,
                  backgroundColor: colors.background.secondary,
                  padding: `${spacing[2]} ${spacing[3]}`,
                  borderRadius: 6,
                  border: `1px solid ${colors.border.default}`,
                }}
              >
                {(settings.intelligenceServiceId as string) ?? "Not connected"}
              </Text>
            </div>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      {/* Invite Modal */}
      <Modal
        opened={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title={
          <Text fw={600} size="lg">
            Invite Member
          </Text>
        }
        size="sm"
      >
        <Stack gap={spacing[4]}>
          <TextInput
            label="Email"
            placeholder="colleague@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.currentTarget.value)}
            required
          />
          <Select
            label="Role"
            data={ROLE_OPTIONS}
            value={inviteRole}
            onChange={(v) =>
              setInviteRole((v as typeof inviteRole) ?? "editor")
            }
          />
          <Button
            onClick={() =>
              createInviteMutation.mutate({
                workspaceId,
                email: inviteEmail,
                role: inviteRole,
              })
            }
            loading={createInviteMutation.isPending}
            disabled={!inviteEmail.trim()}
            fullWidth
          >
            Send Invitation
          </Button>
        </Stack>
      </Modal>

      {/* Create Agent Modal */}
      <Modal
        opened={agentModalOpen}
        onClose={() => {
          setAgentModalOpen(false);
          resetAgentForm();
        }}
        title={
          <Text fw={600} size="lg">
            Create AI Agent
          </Text>
        }
        size="md"
      >
        <Stack gap={spacing[4]}>
          <TextInput
            label="Agent Name"
            placeholder="e.g. Research Assistant"
            value={agentName}
            onChange={(e) => setAgentName(e.currentTarget.value)}
            required
          />
          <Select
            label="Agent Type"
            data={AGENT_TYPE_OPTIONS}
            value={agentType}
            onChange={(v) => setAgentType(v ?? "assistant")}
          />
          <Select
            label="Workspace Role"
            description="Determines what the agent can do in this workspace"
            data={ROLE_OPTIONS}
            value={agentRole}
            onChange={(v) => setAgentRole((v as typeof agentRole) ?? "editor")}
          />
          <Textarea
            label="Description"
            placeholder="What does this agent do?"
            value={agentDescription}
            onChange={(e) => setAgentDescription(e.currentTarget.value)}
            minRows={2}
          />
          <TagsInput
            label="Capabilities"
            placeholder="Type and press Enter"
            value={agentCapabilities}
            onChange={setAgentCapabilities}
            description="e.g. read_entities, write_documents, search"
          />
          <Button
            onClick={() =>
              createAgentMutation.mutate({
                workspaceId,
                name: agentName,
                agentType,
                role: agentRole,
                description: agentDescription || undefined,
                capabilities:
                  agentCapabilities.length > 0 ? agentCapabilities : undefined,
              })
            }
            loading={createAgentMutation.isPending}
            disabled={!agentName.trim()}
            fullWidth
            color="orange"
            leftSection={<IconRobot size={18} />}
          >
            Create Agent
          </Button>
        </Stack>
      </Modal>
    </div>
  );
}

import { useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import {
  Button,
  Card,
  Chip,
  Input,
  Label,
  Modal,
  Spinner,
  Switch,
  Tabs,
  Text,
  TextArea,
  useOverlayState,
} from "@heroui/react";
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

const inputClass =
  "border-default-200 bg-background text-foreground focus:border-accent w-full rounded-lg border px-3 py-2 text-sm outline-none";

const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
  { value: "admin", label: "Admin" },
];

const ROLE_COLORS: Record<string, "accent" | "warning" | "default"> = {
  owner: "accent",
  admin: "warning",
  editor: "accent",
  viewer: "default",
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

  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentType, setAgentType] = useState("assistant");
  const [agentRole, setAgentRole] = useState<"viewer" | "editor" | "admin">(
    "editor"
  );
  const [agentDescription, setAgentDescription] = useState("");
  const [agentCapabilitiesText, setAgentCapabilitiesText] = useState("");

  const inviteModal = useOverlayState({
    isOpen: inviteOpen,
    onOpenChange: setInviteOpen,
  });
  const agentModal = useOverlayState({
    isOpen: agentModalOpen,
    onOpenChange: (open) => {
      setAgentModalOpen(open);
      if (!open) resetAgentForm();
    },
  });

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
  } = trpc.workspaces.listInvites.useQuery({
    type: "workspace",
    workspaceId,
  });

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
    setAgentCapabilitiesText("");
  }

  const agentCapabilities = useMemo(
    () =>
      agentCapabilitiesText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    [agentCapabilitiesText]
  );

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
      <div className="flex justify-center p-8">
        <Spinner size="lg" color="accent" />
      </div>
    );
  }

  if (!workspace) {
    return (
      <div style={{ padding: spacing[6] }}>
        <Text className="text-default-500">Workspace not found.</Text>
      </div>
    );
  }

  const settings = (workspace.settings as Record<string, unknown>) ?? {};

  return (
    <div style={{ padding: spacing[6] }}>
      <div className="mb-6">
        <Link
          to="/workspaces"
          className="inline-flex items-center gap-1 text-sm text-default-500 no-underline hover:text-foreground"
        >
          <IconArrowLeft size={14} />
          Workspaces
        </Link>
      </div>

      <div
        className="mb-6 flex flex-wrap items-center gap-3"
        style={{ marginBottom: spacing[6] }}
      >
        <IconBuildingCommunity size={22} color={colors.eventTypes.created} />
        <div>
          <Text className="text-xl font-bold">{workspace.name}</Text>
          <div className="mt-1 flex flex-wrap gap-2">
            <Chip size="sm" variant="soft" color="default">
              {workspace.type}
            </Chip>
            <Chip
              size="sm"
              variant="soft"
              color={ROLE_COLORS[workspace.role] ?? "default"}
            >
              {workspace.role}
            </Chip>
          </div>
        </div>
      </div>

      <Tabs.Root defaultSelectedKey="members" orientation="horizontal">
        <Tabs.ListContainer>
          <Tabs.List className="mb-4 gap-1 overflow-x-auto">
            <Tabs.Tab id="members" className="px-3 py-2 text-sm">
              Members
            </Tabs.Tab>
            <Tabs.Tab id="agents" className="px-3 py-2 text-sm">
              <span className="inline-flex items-center gap-1">
                <IconRobot size={14} />
                AI Agents
              </span>
            </Tabs.Tab>
            <Tabs.Tab id="invitations" className="px-3 py-2 text-sm">
              Invitations
            </Tabs.Tab>
            <Tabs.Tab id="settings" className="px-3 py-2 text-sm">
              Settings
            </Tabs.Tab>
            <Tabs.Tab id="intelligence" className="px-3 py-2 text-sm">
              Intelligence
            </Tabs.Tab>
            <Tabs.Tab id="services" className="px-3 py-2 text-sm">
              <span className="inline-flex items-center gap-1">
                <IconPlug size={14} />
                Services
              </span>
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id="members" className="pt-1">
          <div className="mb-4 flex justify-between gap-4">
            <Text className="font-semibold">Members</Text>
            <Button
              variant="primary"
              size="sm"
              onPress={() => setInviteOpen(true)}
            >
              <span className="inline-flex items-center gap-2">
                <IconPlus size={16} />
                Invite Member
              </span>
            </Button>
          </div>
          {membersLoading ? (
            <Spinner color="accent" />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-divider">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-divider bg-default-50/80">
                    <th className="px-3 py-2 font-medium">User</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Joined</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {members?.map((m) => (
                    <tr
                      key={m.id}
                      className="border-b border-divider/60 odd:bg-default-50/30 hover:bg-default-100/40"
                    >
                      <td className="px-3 py-2">
                        <Text className="text-sm font-medium">
                          {m.user.name ?? "—"}
                        </Text>
                      </td>
                      <td className="px-3 py-2 text-sm text-default-500">
                        {m.user.email}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className={inputClass}
                          style={{ width: 120 }}
                          value={m.role}
                          onChange={(e) => {
                            const role = e.target.value;
                            if (role && role !== m.role) {
                              updateRoleMutation.mutate({
                                workspaceId,
                                userId: m.userId,
                                role: role as "admin" | "editor" | "viewer",
                              });
                            }
                          }}
                        >
                          {ROLE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-sm text-default-500">
                        {new Date(m.joinedAt).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          className="text-danger"
                          aria-label="Remove member"
                          onPress={() =>
                            removeMemberMutation.mutate({
                              workspaceId,
                              userId: m.userId,
                            })
                          }
                        >
                          <IconTrash size={14} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Tabs.Panel>

        <Tabs.Panel id="agents" className="pt-1">
          <div className="mb-4 flex justify-between gap-4">
            <Text className="font-semibold">AI Agents</Text>
            <Button
              variant="primary"
              size="sm"
              onPress={() => setAgentModalOpen(true)}
            >
              <span className="inline-flex items-center gap-2">
                <IconPlus size={16} />
                Create Agent
              </span>
            </Button>
          </div>
          {agentsLoading ? (
            <Spinner color="accent" />
          ) : !agents || agents.length === 0 ? (
            <Card
              className="border border-dashed border-divider p-8 text-center"
              style={{ borderRadius: borderRadius.lg }}
            >
              <IconRobot
                size={40}
                color={colors.text.tertiary}
                style={{ marginBottom: spacing[2] }}
              />
              <Text className="mb-2 text-sm text-default-600">
                No AI agents in this workspace yet.
              </Text>
              <Text className="text-xs text-default-500">
                Create an agent to automate tasks with workspace-scoped
                permissions.
              </Text>
            </Card>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-divider">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-divider bg-default-50/80">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Capabilities</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <tr
                      key={agent.id}
                      className="border-b border-divider/60 odd:bg-default-50/30 hover:bg-default-100/40"
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <IconRobot size={16} color={colors.eventTypes.ai} />
                          <Text className="text-sm font-medium">
                            {agent.name}
                          </Text>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Chip size="sm" variant="soft" color="warning">
                          {agent.agentMetadata?.agentType || "—"}
                        </Chip>
                      </td>
                      <td className="px-3 py-2">
                        <Chip
                          size="sm"
                          variant="soft"
                          color={ROLE_COLORS[agent.role] ?? "default"}
                        >
                          {agent.role}
                        </Chip>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {agent.agentMetadata?.capabilities
                            ?.slice(0, 3)
                            .map((cap) => (
                              <Chip
                                key={cap}
                                size="sm"
                                variant="soft"
                                color="accent"
                              >
                                {cap}
                              </Chip>
                            ))}
                          {(agent.agentMetadata?.capabilities?.length ?? 0) >
                            3 && (
                            <Chip size="sm" variant="soft" color="default">
                              +
                              {(agent.agentMetadata?.capabilities?.length ??
                                0) - 3}
                            </Chip>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          className="text-danger"
                          aria-label="Remove agent"
                          onPress={() =>
                            removeAgentMutation.mutate({
                              workspaceId,
                              agentUserId: agent.id,
                            })
                          }
                        >
                          <IconTrash size={14} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Tabs.Panel>

        <Tabs.Panel id="invitations" className="pt-1">
          <Text className="mb-4 font-semibold">Pending Invitations</Text>
          {invitesLoading ? (
            <Spinner color="accent" />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-divider">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-divider bg-default-50/80">
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Expires</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invites?.map((inv) => (
                    <tr
                      key={inv.id}
                      className="border-b border-divider/60 odd:bg-default-50/30 hover:bg-default-100/40"
                    >
                      <td className="px-3 py-2 text-sm">{inv.email}</td>
                      <td className="px-3 py-2">
                        <Chip
                          size="sm"
                          variant="soft"
                          color={ROLE_COLORS[inv.role] ?? "default"}
                        >
                          {inv.role}
                        </Chip>
                      </td>
                      <td className="px-3 py-2 text-sm text-default-500">
                        {new Date(inv.expiresAt).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          className="text-danger"
                          aria-label="Revoke invite"
                          onPress={() =>
                            revokeInviteMutation.mutate({ id: inv.id })
                          }
                        >
                          <IconTrash size={14} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {invites?.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center">
                        <Text className="text-default-500">
                          No pending invitations.
                        </Text>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </Tabs.Panel>

        <Tabs.Panel id="settings" className="pt-1">
          <div
            className="flex max-w-md flex-col gap-5"
            style={{ maxWidth: 480 }}
          >
            <Text className="font-semibold">Workspace Settings</Text>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-divider p-3">
              <div>
                <Text className="text-sm font-medium">AI Enabled</Text>
                <Text className="text-xs text-default-500">
                  Allow AI features in this workspace
                </Text>
              </div>
              <Switch
                isSelected={Boolean(settings.aiEnabled)}
                onChange={(v) => handleSettingChange("aiEnabled", v)}
              >
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-divider p-3">
              <div>
                <Text className="text-sm font-medium">External Sharing</Text>
                <Text className="text-xs text-default-500">
                  Allow sharing content outside the workspace
                </Text>
              </div>
              <Switch
                isSelected={Boolean(settings.externalSharing)}
                onChange={(v) => handleSettingChange("externalSharing", v)}
              >
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-divider p-3">
              <div>
                <Text className="text-sm font-medium">AI Auto-Approve</Text>
                <Text className="text-xs text-default-500">
                  Automatically approve AI-proposed changes
                </Text>
              </div>
              <Switch
                isSelected={Boolean(
                  (settings.aiGovernance as Record<string, unknown>)
                    ?.autoApprove
                )}
                onChange={(v) =>
                  handleSettingChange("aiGovernance", {
                    ...((settings.aiGovernance as Record<string, unknown>) ??
                      {}),
                    autoApprove: v,
                  })
                }
              >
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch>
            </div>
          </div>
        </Tabs.Panel>

        <Tabs.Panel id="services" className="pt-1">
          <div
            className="flex max-w-xl flex-col gap-3"
            style={{ maxWidth: 560 }}
          >
            <Text className="font-semibold">External Agent Services</Text>
            <Text className="text-sm text-default-500">
              Provision Docker-based agent containers (OpenClaw, ZeroClaw, …)
              that connect to this workspace via Hub Protocol.
            </Text>
            <Link
              to="/connections?tab=advanced-sources"
              className="no-underline"
            >
              <Button variant="ghost" className="w-fit">
                <span className="inline-flex items-center gap-2">
                  <IconPlug size={16} />
                  Manage Integrations
                </span>
              </Button>
            </Link>
          </div>
        </Tabs.Panel>

        <Tabs.Panel id="intelligence" className="pt-1">
          <div
            className="flex max-w-md flex-col gap-4"
            style={{ maxWidth: 480 }}
          >
            <Text className="font-semibold">Intelligence Service</Text>
            <div>
              <Text className="mb-2 text-sm text-default-500">
                Connected Service ID
              </Text>
              <div
                className="rounded-md border border-divider px-3 py-2 text-sm"
                style={{
                  fontFamily: typography.fontFamily.mono,
                  backgroundColor: colors.background.secondary,
                }}
              >
                {(settings.intelligenceServiceId as string) ?? "Not connected"}
              </div>
            </div>
          </div>
        </Tabs.Panel>
      </Tabs.Root>

      <Modal state={inviteModal}>
        <Modal.Backdrop isDismissable>
          <Modal.Container size="sm" placement="center">
            <Modal.Dialog>
              <Modal.Header className="flex flex-col gap-1 border-b border-divider px-6 py-4">
                <Modal.Heading className="text-lg font-semibold">
                  Invite Member
                </Modal.Heading>
                <Modal.CloseTrigger className="absolute right-3 top-3" />
              </Modal.Header>
              <Modal.Body className="gap-4 px-6 py-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="invite-email">Email</Label>
                  <Input
                    id="invite-email"
                    className={inputClass}
                    placeholder="colleague@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="invite-role">Role</Label>
                  <select
                    id="invite-role"
                    className={inputClass}
                    value={inviteRole}
                    onChange={(e) =>
                      setInviteRole(
                        (e.target.value as typeof inviteRole) ?? "editor"
                      )
                    }
                  >
                    {ROLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  variant="primary"
                  fullWidth
                  isDisabled={
                    !inviteEmail.trim() || createInviteMutation.isPending
                  }
                  onPress={() =>
                    createInviteMutation.mutate({
                      type: "workspace",
                      workspaceId,
                      email: inviteEmail,
                      role: inviteRole,
                    })
                  }
                >
                  {createInviteMutation.isPending ? (
                    <Spinner size="sm" color="current" />
                  ) : (
                    "Send Invitation"
                  )}
                </Button>
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Modal state={agentModal}>
        <Modal.Backdrop isDismissable>
          <Modal.Container size="md" placement="center">
            <Modal.Dialog>
              <Modal.Header className="flex flex-col gap-1 border-b border-divider px-6 py-4">
                <Modal.Heading className="text-lg font-semibold">
                  Create AI Agent
                </Modal.Heading>
                <Modal.CloseTrigger className="absolute right-3 top-3" />
              </Modal.Header>
              <Modal.Body className="gap-4 px-6 py-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-name">Agent Name</Label>
                  <Input
                    id="agent-name"
                    className={inputClass}
                    placeholder="e.g. Research Assistant"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-type">Agent Type</Label>
                  <select
                    id="agent-type"
                    className={inputClass}
                    value={agentType}
                    onChange={(e) => setAgentType(e.target.value)}
                  >
                    {AGENT_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-role">Workspace Role</Label>
                  <Text className="text-xs text-default-500">
                    Determines what the agent can do in this workspace
                  </Text>
                  <select
                    id="agent-role"
                    className={inputClass}
                    value={agentRole}
                    onChange={(e) =>
                      setAgentRole(
                        (e.target.value as typeof agentRole) ?? "editor"
                      )
                    }
                  >
                    {ROLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-desc">Description</Label>
                  <TextArea
                    id="agent-desc"
                    className={inputClass}
                    placeholder="What does this agent do?"
                    value={agentDescription}
                    onChange={(e) => setAgentDescription(e.target.value)}
                    rows={2}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-caps">Capabilities</Label>
                  <Text className="text-xs text-default-500">
                    One per line (e.g. read_entities, write_documents, search)
                  </Text>
                  <TextArea
                    id="agent-caps"
                    className={inputClass}
                    placeholder={"read_entities\nwrite_documents"}
                    value={agentCapabilitiesText}
                    onChange={(e) => setAgentCapabilitiesText(e.target.value)}
                    rows={4}
                  />
                </div>
                <Button
                  variant="primary"
                  fullWidth
                  isDisabled={
                    !agentName.trim() || createAgentMutation.isPending
                  }
                  onPress={() =>
                    createAgentMutation.mutate({
                      workspaceId,
                      name: agentName,
                      agentType,
                      role: agentRole,
                      description: agentDescription || undefined,
                      capabilities:
                        agentCapabilities.length > 0
                          ? agentCapabilities
                          : undefined,
                    })
                  }
                >
                  {createAgentMutation.isPending ? (
                    <Spinner size="sm" color="current" />
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <IconRobot size={18} />
                      Create Agent
                    </span>
                  )}
                </Button>
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

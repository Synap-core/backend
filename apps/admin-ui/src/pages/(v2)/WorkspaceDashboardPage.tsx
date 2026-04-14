import { useNavigate, Link } from "react-router-dom";
import { Button, Card, Chip, Spinner, Text } from "@heroui/react";
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

const WORKSPACE_TYPE_COLORS: Record<string, "accent" | "success" | "warning"> =
  {
    personal: "accent",
    team: "success",
    enterprise: "warning",
  };

const ROLE_COLORS: Record<string, "accent" | "warning" | "default"> = {
  owner: "accent",
  admin: "warning",
  editor: "accent",
  viewer: "default",
};

const PROPOSAL_STATUS_COLORS: Record<string, "warning" | "success" | "danger"> =
  {
    pending: "warning",
    validated: "success",
    rejected: "danger",
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
        <Text className="text-sm text-default-500">No workspace selected.</Text>
      </div>
    );
  }

  return (
    <div className="w-full" style={{ padding: spacing[8] }}>
      <div className="flex flex-col gap-6" style={{ gap: spacing[6] }}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div
              className="mb-1 flex flex-wrap items-center gap-2"
              style={{ marginBottom: spacing[1] }}
            >
              <IconBuildingCommunity
                size={20}
                color={colors.eventTypes.created}
              />
              <h1
                className="m-0 text-2xl font-bold text-foreground"
                style={{ fontFamily: typography.fontFamily.sans }}
              >
                {workspaceName ?? "Workspace"}
              </h1>
              {workspace ? (
                <Chip
                  size="sm"
                  variant="soft"
                  color={WORKSPACE_TYPE_COLORS[workspace.type] ?? "default"}
                >
                  {workspace.type}
                </Chip>
              ) : null}
              {workspace?.role ? (
                <Chip
                  size="sm"
                  variant="soft"
                  color={ROLE_COLORS[workspace.role] ?? "default"}
                >
                  {workspace.role}
                </Chip>
              ) : null}
            </div>
            <Text className="text-sm text-default-500">
              Workspace overview — members, agents, and pending actions
            </Text>
          </div>
          <Link to={`/workspaces/${workspaceId}`} className="no-underline">
            <Button variant="ghost">
              <span className="inline-flex items-center gap-2">
                <IconSettings size={16} />
                Manage Workspace
                <IconArrowRight size={14} />
              </span>
            </Button>
          </Link>
        </div>

        <div
          className="grid gap-4"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: spacing[4],
          }}
        >
          <Card
            className="cursor-pointer border border-divider p-4 transition-colors hover:bg-default-100/40"
            style={{ borderRadius: borderRadius.lg }}
            onClick={() => navigate(`/workspaces/${workspaceId}`)}
          >
            <div className="mb-2 flex items-center justify-between">
              <Text className="text-sm font-medium text-default-600">
                Members
              </Text>
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/15 text-accent">
                <IconUsers size={16} />
              </div>
            </div>
            {membersLoading ? (
              <Spinner size="sm" color="accent" />
            ) : (
              <>
                <p className="m-0 text-3xl font-bold text-foreground">
                  {memberCount}
                </p>
                <Text
                  className="mt-1 text-xs text-default-500"
                  style={{ marginTop: spacing[1] }}
                >
                  active members
                </Text>
              </>
            )}
          </Card>

          <Card
            className="cursor-pointer border border-divider p-4 transition-colors hover:bg-default-100/40"
            style={{ borderRadius: borderRadius.lg }}
            onClick={() => navigate(`/workspaces/${workspaceId}`)}
          >
            <div className="mb-2 flex items-center justify-between">
              <Text className="text-sm font-medium text-default-600">
                Agents
              </Text>
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-warning/15 text-warning">
                <IconRobot size={16} />
              </div>
            </div>
            {agentsLoading ? (
              <Spinner size="sm" color="accent" />
            ) : (
              <>
                <p className="m-0 text-3xl font-bold text-foreground">
                  {agentCount}
                </p>
                <Text
                  className="mt-1 text-xs text-default-500"
                  style={{ marginTop: spacing[1] }}
                >
                  AI agents
                </Text>
              </>
            )}
          </Card>

          <Card
            className="cursor-pointer border border-divider p-4 transition-colors hover:bg-default-100/40"
            style={{ borderRadius: borderRadius.lg }}
            onClick={() => navigate("/proposals")}
          >
            <div className="mb-2 flex items-center justify-between">
              <Text className="text-sm font-medium text-default-600">
                Pending
              </Text>
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-warning/15 text-warning">
                <IconCheckbox size={16} />
              </div>
            </div>
            {proposalsLoading ? (
              <Spinner size="sm" color="accent" />
            ) : (
              <>
                <p className="m-0 text-3xl font-bold text-foreground">
                  {pendingProposals.length}
                </p>
                <Text
                  className="mt-1 text-xs text-default-500"
                  style={{ marginTop: spacing[1] }}
                >
                  proposals to review
                </Text>
              </>
            )}
          </Card>

          <Card
            className="cursor-pointer border border-divider p-4 transition-colors hover:bg-default-100/40"
            style={{ borderRadius: borderRadius.lg }}
            onClick={() => navigate("/intelligence")}
          >
            <div className="mb-2 flex items-center justify-between">
              <Text className="text-sm font-medium text-default-600">
                Intelligence
              </Text>
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/15 text-accent">
                <IconBrain size={16} />
              </div>
            </div>
            {isLoading ? (
              <Spinner size="sm" color="accent" />
            ) : (
              <>
                <Text
                  className={`text-sm font-semibold ${
                    workspace?.settings?.intelligenceServiceId
                      ? "text-success"
                      : "text-default-500"
                  }`}
                >
                  {workspace?.settings?.intelligenceServiceId
                    ? "Connected"
                    : "Not connected"}
                </Text>
                <Text
                  className="mt-1 text-xs text-default-500"
                  style={{ marginTop: spacing[1] }}
                >
                  AI service
                </Text>
              </>
            )}
          </Card>
        </div>

        <Card
          className="border border-divider p-4"
          style={{ borderRadius: borderRadius.lg }}
        >
          <Text className="mb-3 text-sm font-semibold text-foreground">
            Quick Actions
          </Text>
          <div className="flex flex-wrap gap-3">
            <Link to={`/workspaces/${workspaceId}`} className="no-underline">
              <Button variant="ghost" size="sm">
                <span className="inline-flex items-center gap-2">
                  <IconPlus size={16} />
                  Invite Member
                </span>
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => navigate("/proposals")}
            >
              <span className="inline-flex items-center gap-2">
                <IconCheckbox size={16} />
                Review Proposals
              </span>
            </Button>
            <Link to={`/workspaces/${workspaceId}`} className="no-underline">
              <Button variant="ghost" size="sm">
                <span className="inline-flex items-center gap-2">
                  <IconRobot size={16} />
                  Manage Agents
                </span>
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => navigate("/intelligence")}
            >
              <span className="inline-flex items-center gap-2">
                <IconBrain size={16} />
                Configure Intelligence
              </span>
            </Button>
          </div>
        </Card>

        <Card
          className="border border-divider p-4"
          style={{ borderRadius: borderRadius.lg }}
        >
          <div className="mb-3 flex items-center justify-between">
            <Text className="text-sm font-semibold text-foreground">
              Pending Proposals
            </Text>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => navigate("/proposals")}
            >
              <span className="inline-flex items-center gap-1">
                View all
                <IconArrowRight size={12} />
              </span>
            </Button>
          </div>

          {proposalsLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="sm" color="accent" />
            </div>
          ) : pendingProposals.length === 0 ? (
            <Text className="py-8 text-center text-sm text-default-500">
              No pending proposals
            </Text>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-divider bg-default-50/80">
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingProposals.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-divider/60 transition-colors hover:bg-default-100/50"
                    >
                      <td className="px-3 py-2">
                        <Text className="line-clamp-1 text-sm font-medium">
                          {(
                            p.request as
                              | { operation?: string }
                              | null
                              | undefined
                          )?.operation ?? p.id}
                        </Text>
                      </td>
                      <td className="px-3 py-2">
                        <Chip size="sm" variant="soft" color="default">
                          {p.targetType}
                        </Chip>
                      </td>
                      <td className="px-3 py-2">
                        <Chip
                          size="sm"
                          variant="soft"
                          color={PROPOSAL_STATUS_COLORS[p.status] ?? "default"}
                        >
                          {p.status}
                        </Chip>
                      </td>
                      <td className="px-3 py-2">
                        <Text className="text-xs text-default-500">
                          {timeSince(p.createdAt)}
                        </Text>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

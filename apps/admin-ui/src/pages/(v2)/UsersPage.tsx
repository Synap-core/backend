import { useState } from "react";
import {
  Button,
  Card,
  Chip,
  Label,
  Modal,
  Spinner,
  Text,
  useOverlayState,
} from "@heroui/react";
import { IconRobot, IconUser } from "@tabler/icons-react";
import { typography, spacing, borderRadius } from "../../theme/tokens";
import { trpc } from "../../lib/trpc";

type UserType = "all" | "human" | "agent";

interface AgentMetadata {
  agentType?: string;
  description?: string;
  capabilities?: string[];
  createdByUserId?: string;
}

const FILTER_OPTIONS: { value: UserType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "human", label: "Human" },
  { value: "agent", label: "Agents" },
];

export default function UsersPage() {
  const [typeFilter, setTypeFilter] = useState<UserType>("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const detailModal = useOverlayState({
    isOpen: !!selectedUserId,
    onOpenChange: (open) => {
      if (!open) setSelectedUserId(null);
    },
  });

  const { data, isLoading } = trpc.system.listUsers.useQuery({
    type: typeFilter,
    limit: 100,
  });

  const selectedUser = data?.users.find((u) => u.id === selectedUserId);

  return (
    <div style={{ width: "100%", padding: spacing[8] }}>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1
            className="m-0 text-2xl font-bold"
            style={{ fontFamily: typography.fontFamily.sans }}
          >
            Users
          </h1>
          <Text className="mt-1 text-sm text-default-500">
            All users across the Data Pod
          </Text>
        </div>
        <div className="inline-flex rounded-lg bg-default-100 p-1">
          {FILTER_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={typeFilter === opt.value ? "primary" : "ghost"}
              className="min-w-[4.5rem]"
              onPress={() => setTypeFilter(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      <Card
        className="overflow-hidden border border-divider"
        style={{ borderRadius: borderRadius.lg }}
      >
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" color="accent" />
          </div>
        ) : !data || data.users.length === 0 ? (
          <Text className="p-8 text-center text-sm text-default-500">
            No users found
          </Text>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-divider bg-default-50/80">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Workspaces</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr
                    key={user.id}
                    className="cursor-pointer border-b border-divider/60 transition-colors hover:bg-default-100/60"
                    onClick={() => setSelectedUserId(user.id)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {user.userType === "agent" ? (
                          <IconRobot size={16} className="text-warning" />
                        ) : (
                          <IconUser size={16} className="text-accent" />
                        )}
                        <span className="font-medium">{user.name || "—"}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-default-600">
                      {user.email}
                    </td>
                    <td className="px-4 py-3">
                      <Chip
                        size="sm"
                        variant="soft"
                        color={user.userType === "agent" ? "warning" : "accent"}
                      >
                        {user.userType}
                      </Chip>
                    </td>
                    <td className="px-4 py-3 text-default-500">
                      {user.createdAt
                        ? new Date(user.createdAt).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Chip size="sm" variant="soft" color="default">
                        {user.workspaceMembershipCount}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data && (
        <Text className="mt-2 text-right text-xs text-default-400">
          Showing {data.users.length} of {data.pagination.total} users
        </Text>
      )}

      <Modal state={detailModal}>
        <Modal.Backdrop isDismissable />
        <Modal.Container size="md" placement="center">
          <Modal.Dialog>
            <Modal.Header className="flex flex-col gap-1 border-b border-divider px-6 py-4">
              <Modal.Heading className="text-lg font-semibold">
                User Details
              </Modal.Heading>
              <Modal.CloseTrigger className="absolute right-3 top-3" />
            </Modal.Header>
            <Modal.Body className="gap-4 px-6 py-4">
              {selectedUser && (
                <>
                  <div>
                    <Label className="text-default-500">Name</Label>
                    <Text className="mt-1 font-medium">
                      {selectedUser.name || "—"}
                    </Text>
                  </div>
                  <div>
                    <Label className="text-default-500">Email</Label>
                    <Text
                      className="mt-1 font-mono text-sm"
                      style={{ fontFamily: typography.fontFamily.mono }}
                    >
                      {selectedUser.email}
                    </Text>
                  </div>
                  <div>
                    <Label className="text-default-500">ID</Label>
                    <Text
                      className="mt-1 font-mono text-sm break-all"
                      style={{ fontFamily: typography.fontFamily.mono }}
                    >
                      {selectedUser.id}
                    </Text>
                  </div>
                  <div className="flex flex-wrap gap-6">
                    <div>
                      <Label className="text-default-500">Type</Label>
                      <div className="mt-1">
                        <Chip
                          size="sm"
                          variant="soft"
                          color={
                            selectedUser.userType === "agent"
                              ? "warning"
                              : "accent"
                          }
                        >
                          {selectedUser.userType}
                        </Chip>
                      </div>
                    </div>
                    <div>
                      <Label className="text-default-500">Workspaces</Label>
                      <div className="mt-1">
                        <Chip size="sm" variant="soft" color="default">
                          {selectedUser.workspaceMembershipCount} memberships
                        </Chip>
                      </div>
                    </div>
                  </div>
                  <div>
                    <Label className="text-default-500">Created</Label>
                    <Text className="mt-1 text-sm">
                      {selectedUser.createdAt
                        ? new Date(selectedUser.createdAt).toLocaleString()
                        : "—"}
                    </Text>
                  </div>
                  {selectedUser.userType === "agent" &&
                    selectedUser.agentMetadata && (
                      <Card className="border border-divider bg-default-50/80 p-4">
                        <Text className="mb-3 font-semibold text-sm">
                          Agent Metadata
                        </Text>
                        <div className="flex flex-col gap-3">
                          <div>
                            <Label className="text-default-500">
                              Agent Type
                            </Label>
                            <Text className="mt-1 text-sm">
                              {(selectedUser.agentMetadata as AgentMetadata)
                                .agentType || "—"}
                            </Text>
                          </div>
                          <div>
                            <Label className="text-default-500">
                              Description
                            </Label>
                            <Text className="mt-1 text-sm">
                              {(selectedUser.agentMetadata as AgentMetadata)
                                .description || "—"}
                            </Text>
                          </div>
                          {(selectedUser.agentMetadata as AgentMetadata)
                            .capabilities && (
                            <div>
                              <Label className="mb-2 text-default-500">
                                Capabilities
                              </Label>
                              <div className="flex flex-wrap gap-1">
                                {(
                                  selectedUser.agentMetadata as AgentMetadata
                                ).capabilities!.map((cap) => (
                                  <Chip
                                    key={cap}
                                    size="sm"
                                    variant="soft"
                                    color="accent"
                                  >
                                    {cap}
                                  </Chip>
                                ))}
                              </div>
                            </div>
                          )}
                          <div>
                            <Label className="text-default-500">
                              Created By
                            </Label>
                            <Text
                              className="mt-1 font-mono text-sm"
                              style={{
                                fontFamily: typography.fontFamily.mono,
                              }}
                            >
                              {(selectedUser.agentMetadata as AgentMetadata)
                                .createdByUserId || "—"}
                            </Text>
                          </div>
                        </div>
                      </Card>
                    )}
                </>
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal>
    </div>
  );
}

import { useState } from "react";
import {
  Button,
  Card,
  Chip,
  Label,
  Modal,
  Spinner,
  Table,
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
  const [passwordResetResult, setPasswordResetResult] = useState<{
    mode: "single" | "all_humans";
    resetCount: number;
    failedCount: number;
    results: Array<{ userId: string; email: string; tempPassword: string }>;
    failures: Array<{ userId: string; email: string; error: string }>;
  } | null>(null);

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
  const utils = trpc.useUtils();
  const resetPasswordMutation = trpc.system.resetUserPassword.useMutation({
    onSuccess: (result) => {
      setPasswordResetResult(result);
      void utils.system.listUsers.invalidate();
    },
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
        <Button
          variant="secondary"
          isDisabled={resetPasswordMutation.isPending}
          onPress={() => {
            setPasswordResetResult(null);
            resetPasswordMutation.mutate({ mode: "all_humans" });
          }}
        >
          {resetPasswordMutation.isPending ? (
            <span className="inline-flex items-center gap-2">
              <Spinner size="sm" color="current" />
              Resetting…
            </span>
          ) : (
            "Reset All Human Passwords"
          )}
        </Button>
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
          <Table variant="secondary">
            <Table.ScrollContainer>
              <Table.Content aria-label="Users table">
                <Table.Header>
                  <Table.Column>Name</Table.Column>
                  <Table.Column>Email</Table.Column>
                  <Table.Column>Type</Table.Column>
                  <Table.Column>Created</Table.Column>
                  <Table.Column>Workspaces</Table.Column>
                </Table.Header>
                <Table.Body>
                  {data.users.map((user) => (
                    <Table.Row key={user.id} id={user.id}>
                      <Table.Cell>
                        <Button
                          variant="ghost"
                          className="h-auto min-h-0 px-0 py-0 text-left"
                          onPress={() => setSelectedUserId(user.id)}
                        >
                          <span className="flex items-center gap-2">
                            {user.userType === "agent" ? (
                              <IconRobot size={16} className="text-warning" />
                            ) : (
                              <IconUser size={16} className="text-accent" />
                            )}
                            <span className="font-medium">
                              {user.name || "—"}
                            </span>
                          </span>
                        </Button>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="font-mono text-default-600">
                          {user.email}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip
                          size="sm"
                          variant="soft"
                          color={
                            user.userType === "agent" ? "warning" : "accent"
                          }
                        >
                          {user.userType}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="text-default-500">
                          {user.createdAt
                            ? new Date(user.createdAt).toLocaleDateString()
                            : "—"}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip size="sm" variant="soft" color="default">
                          {user.workspaceMembershipCount}
                        </Chip>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </Card>

      {data && (
        <Text className="mt-2 text-right text-xs text-default-400">
          Showing {data.users.length} of {data.pagination.total} users
        </Text>
      )}

      <Modal state={detailModal}>
        <Modal.Backdrop isDismissable>
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
                    <Card className="border border-divider bg-default-50/80 p-4">
                      <Text className="mb-3 font-semibold text-sm">
                        Password Management
                      </Text>
                      <div className="flex items-center justify-between gap-3">
                        <Text className="text-xs text-default-500">
                          Generates a temporary password and updates Kratos
                          immediately.
                        </Text>
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={resetPasswordMutation.isPending}
                          onPress={() => {
                            if (!selectedUser?.id) return;
                            setPasswordResetResult(null);
                            resetPasswordMutation.mutate({
                              mode: "single",
                              userId: selectedUser.id,
                            });
                          }}
                        >
                          {resetPasswordMutation.isPending ? (
                            <span className="inline-flex items-center gap-2">
                              <Spinner size="sm" color="current" />
                              Resetting…
                            </span>
                          ) : (
                            "Reset Password"
                          )}
                        </Button>
                      </div>
                    </Card>
                    {passwordResetResult && (
                      <Card className="border border-divider bg-default-50/80 p-4">
                        <Text className="mb-2 font-semibold text-sm">
                          Password Reset Result
                        </Text>
                        <Text className="mb-3 text-xs text-default-500">
                          Resets: {passwordResetResult.resetCount} · Failures:{" "}
                          {passwordResetResult.failedCount}
                        </Text>
                        <div className="flex flex-col gap-2">
                          {passwordResetResult.results.map((item) => (
                            <div
                              key={`ok-${item.userId}`}
                              className="rounded-md border border-divider bg-content1 px-3 py-2"
                            >
                              <Text className="text-xs text-default-500">
                                {item.email}
                              </Text>
                              <Text
                                className="font-mono text-sm"
                                style={{
                                  fontFamily: typography.fontFamily.mono,
                                }}
                              >
                                {item.tempPassword}
                              </Text>
                            </div>
                          ))}
                          {passwordResetResult.failures.map((failure) => (
                            <div
                              key={`fail-${failure.userId}`}
                              className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2"
                            >
                              <Text className="text-xs font-medium text-danger">
                                {failure.email}
                              </Text>
                              <Text className="text-xs text-danger/80">
                                {failure.error}
                              </Text>
                            </div>
                          ))}
                        </div>
                      </Card>
                    )}
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
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

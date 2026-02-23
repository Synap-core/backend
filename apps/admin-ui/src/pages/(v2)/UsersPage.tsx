import { useState } from "react";
import {
  Title,
  Text,
  Stack,
  Card,
  Group,
  Badge,
  Table,
  SegmentedControl,
  Loader,
  Modal,
} from "@mantine/core";
import { IconUsers, IconRobot, IconUser } from "@tabler/icons-react";
import { colors, typography, spacing, borderRadius } from "../../theme/tokens";
import { trpc } from "../../lib/trpc";

type UserType = "all" | "human" | "agent";

export default function UsersPage() {
  const [typeFilter, setTypeFilter] = useState<UserType>("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const { data, isLoading } = trpc.system.listUsers.useQuery({
    type: typeFilter,
    limit: 100,
  });

  const selectedUser = data?.users.find((u) => u.id === selectedUserId);

  return (
    <div style={{ width: "100%", padding: spacing[8] }}>
      <Stack gap={spacing[6]}>
        {/* Header */}
        <Group justify="space-between">
          <div>
            <Title
              order={1}
              style={{
                fontFamily: typography.fontFamily.sans,
                color: colors.text.primary,
              }}
            >
              Users
            </Title>
            <Text
              size="sm"
              style={{
                color: colors.text.secondary,
                fontFamily: typography.fontFamily.sans,
              }}
            >
              All users across the Data Pod
            </Text>
          </div>
          <SegmentedControl
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as UserType)}
            data={[
              { label: "All", value: "all" },
              { label: "Human", value: "human" },
              { label: "Agents", value: "agent" },
            ]}
          />
        </Group>

        {/* Users Table */}
        <Card
          padding={0}
          radius={borderRadius.lg}
          style={{
            border: `1px solid ${colors.border.default}`,
            backgroundColor: colors.background.primary,
          }}
        >
          {isLoading ? (
            <div style={{ padding: spacing[8], textAlign: "center" }}>
              <Loader />
            </div>
          ) : !data || data.users.length === 0 ? (
            <Text
              size="sm"
              c={colors.text.tertiary}
              ta="center"
              p={spacing[8]}
            >
              No users found
            </Text>
          ) : (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Email</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Workspaces</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.users.map((user) => (
                  <Table.Tr
                    key={user.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => setSelectedUserId(user.id)}
                  >
                    <Table.Td>
                      <Group gap={spacing[2]}>
                        {user.userType === "agent" ? (
                          <IconRobot size={16} color={colors.eventTypes.ai} />
                        ) : (
                          <IconUser size={16} color={colors.semantic.info} />
                        )}
                        <Text size="sm" fw={500}>
                          {user.name || "—"}
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed" style={{ fontFamily: typography.fontFamily.mono }}>
                        {user.email}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="sm"
                        variant="light"
                        color={user.userType === "agent" ? "orange" : "blue"}
                      >
                        {user.userType}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {user.createdAt
                          ? new Date(user.createdAt).toLocaleDateString()
                          : "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="outline" color="gray">
                        {user.workspaceMembershipCount}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>

        {data && (
          <Text size="xs" c={colors.text.tertiary} ta="right">
            Showing {data.users.length} of {data.pagination.total} users
          </Text>
        )}
      </Stack>

      {/* User Detail Modal */}
      <Modal
        opened={!!selectedUserId}
        onClose={() => setSelectedUserId(null)}
        title={
          <Text fw={600} size="lg">
            User Details
          </Text>
        }
        size="md"
      >
        {selectedUser && (
          <Stack gap={spacing[4]}>
            <div>
              <Text size="xs" c="dimmed" mb={2}>Name</Text>
              <Text size="sm" fw={500}>{selectedUser.name || "—"}</Text>
            </div>
            <div>
              <Text size="xs" c="dimmed" mb={2}>Email</Text>
              <Text size="sm" style={{ fontFamily: typography.fontFamily.mono }}>
                {selectedUser.email}
              </Text>
            </div>
            <div>
              <Text size="xs" c="dimmed" mb={2}>ID</Text>
              <Text size="sm" style={{ fontFamily: typography.fontFamily.mono }}>
                {selectedUser.id}
              </Text>
            </div>
            <Group>
              <div>
                <Text size="xs" c="dimmed" mb={2}>Type</Text>
                <Badge
                  variant="light"
                  color={selectedUser.userType === "agent" ? "orange" : "blue"}
                >
                  {selectedUser.userType}
                </Badge>
              </div>
              <div>
                <Text size="xs" c="dimmed" mb={2}>Workspaces</Text>
                <Badge variant="outline" color="gray">
                  {selectedUser.workspaceMembershipCount} memberships
                </Badge>
              </div>
            </Group>
            <div>
              <Text size="xs" c="dimmed" mb={2}>Created</Text>
              <Text size="sm">
                {selectedUser.createdAt
                  ? new Date(selectedUser.createdAt).toLocaleString()
                  : "—"}
              </Text>
            </div>
            {selectedUser.userType === "agent" && selectedUser.agentMetadata && (
              <Card
                padding={spacing[3]}
                radius={borderRadius.md}
                style={{
                  backgroundColor: colors.background.secondary,
                  border: `1px solid ${colors.border.light}`,
                }}
              >
                <Text size="sm" fw={600} mb={spacing[2]}>
                  Agent Metadata
                </Text>
                <Stack gap={spacing[2]}>
                  <div>
                    <Text size="xs" c="dimmed">Agent Type</Text>
                    <Text size="sm">
                      {(selectedUser.agentMetadata as any).agentType || "—"}
                    </Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">Description</Text>
                    <Text size="sm">
                      {(selectedUser.agentMetadata as any).description || "—"}
                    </Text>
                  </div>
                  {(selectedUser.agentMetadata as any).capabilities && (
                    <div>
                      <Text size="xs" c="dimmed" mb={2}>Capabilities</Text>
                      <Group gap={4}>
                        {((selectedUser.agentMetadata as any).capabilities as string[]).map(
                          (cap: string) => (
                            <Badge key={cap} size="xs" variant="light" color="cyan">
                              {cap}
                            </Badge>
                          )
                        )}
                      </Group>
                    </div>
                  )}
                  <div>
                    <Text size="xs" c="dimmed">Created By</Text>
                    <Text size="sm" style={{ fontFamily: typography.fontFamily.mono }}>
                      {(selectedUser.agentMetadata as any).createdByUserId || "—"}
                    </Text>
                  </div>
                </Stack>
              </Card>
            )}
          </Stack>
        )}
      </Modal>
    </div>
  );
}

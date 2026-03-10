import { useState } from "react";
import {
  Button,
  Text,
  Badge,
  Modal,
  TextInput,
  Textarea,
  Select,
  SimpleGrid,
  Card,
  Group,
  Stack,
  Loader,
} from "@mantine/core";
import {
  IconBuildingCommunity,
  IconPlus,
  IconUsers,
  IconArrowRight,
} from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { trpc } from "../../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing } from "../../theme/tokens";

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

export default function WorkspacesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"personal" | "team" | "enterprise">("team");

  const {
    data: workspaces,
    isLoading,
    refetch,
  } = trpc.workspaces.list.useQuery();

  const createMutation = trpc.workspaces.create.useMutation({
    onSuccess: () => {
      refetch();
      setCreateOpen(false);
      setName("");
      setDescription("");
      setType("team");
      showSuccessNotification({ message: "Workspace created successfully" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  function handleCreate() {
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      description: description || undefined,
      type,
    });
  }

  return (
    <div style={{ padding: spacing[6] }}>
      {/* Header */}
      <Group justify="space-between" mb={spacing[6]}>
        <div>
          <Group gap="sm" mb={spacing[1]}>
            <IconBuildingCommunity
              size={22}
              color={colors.eventTypes.created}
            />
            <Text size="xl" fw={700}>
              Workspaces
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            Manage workspaces, members, and settings.
          </Text>
        </div>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => setCreateOpen(true)}
          color="violet"
        >
          New Workspace
        </Button>
      </Group>

      {isLoading ? (
        <Loader />
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing={spacing[4]}>
          {workspaces?.map((ws) => (
            <Card
              key={ws.id}
              shadow="sm"
              padding="lg"
              radius="md"
              withBorder
              style={{
                borderColor: colors.border.default,
                cursor: "pointer",
                transition: "box-shadow 0.15s ease",
              }}
            >
              <Stack gap={spacing[3]}>
                {/* Name + type badge */}
                <Group justify="space-between" align="flex-start">
                  <Text fw={600} size="md" style={{ flex: 1 }}>
                    {ws.name}
                  </Text>
                  <Badge
                    size="xs"
                    color={WORKSPACE_TYPE_COLORS[ws.type] ?? "gray"}
                    variant="light"
                  >
                    {ws.type}
                  </Badge>
                </Group>

                {/* Role badge */}
                <Badge
                  size="xs"
                  color={ROLE_COLORS[ws.role] ?? "gray"}
                  variant="outline"
                  style={{ alignSelf: "flex-start" }}
                >
                  {ws.role}
                </Badge>

                {/* Description */}
                {ws.description && (
                  <Text size="sm" c="dimmed" lineClamp={2}>
                    {ws.description}
                  </Text>
                )}

                {/* Meta info */}
                <Group gap={spacing[4]}>
                  <Group gap={4}>
                    <IconUsers size={14} color={colors.text.tertiary} />
                    <Text size="xs" c="dimmed">
                      {ws.settings?.intelligenceServiceId
                        ? "AI connected"
                        : "No AI service"}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {new Date(ws.createdAt).toLocaleDateString()}
                  </Text>
                </Group>

                {/* Manage button */}
                <Button
                  component={Link}
                  to={`/workspaces/${ws.id}`}
                  variant="light"
                  size="xs"
                  rightSection={<IconArrowRight size={14} />}
                  fullWidth
                  color="violet"
                >
                  Manage
                </Button>
              </Stack>
            </Card>
          ))}

          {workspaces?.length === 0 && (
            <Text
              c="dimmed"
              ta="center"
              py={spacing[10]}
              style={{ gridColumn: "1 / -1" }}
            >
              No workspaces found.
            </Text>
          )}
        </SimpleGrid>
      )}

      {/* Create Modal */}
      <Modal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        title={
          <Text fw={600} size="lg">
            Create Workspace
          </Text>
        }
        size="md"
      >
        <Stack gap={spacing[4]}>
          <TextInput
            label="Name"
            placeholder="My Team Workspace"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
          />
          <Textarea
            label="Description"
            placeholder="Optional description"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            rows={3}
          />
          <Select
            label="Type"
            data={[
              { value: "personal", label: "Personal" },
              { value: "team", label: "Team" },
              { value: "enterprise", label: "Enterprise" },
            ]}
            value={type}
            onChange={(v) => setType((v as typeof type) ?? "team")}
          />
          <Button
            onClick={handleCreate}
            loading={createMutation.isPending}
            disabled={!name.trim()}
            fullWidth
          >
            Create
          </Button>
        </Stack>
      </Modal>
    </div>
  );
}

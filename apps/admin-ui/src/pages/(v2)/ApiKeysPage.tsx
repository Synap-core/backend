import { useState } from "react";
import {
  Button,
  Text,
  Badge,
  Modal,
  TextInput,
  MultiSelect,
  NumberInput,
  Alert,
  Code,
  Table,
  ActionIcon,
  Tooltip,
  Group,
  Stack,
  Loader,
} from "@mantine/core";
import {
  IconKey,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconCopy,
  IconAlertCircle,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing, typography } from "../../theme/tokens";

const HUB_SCOPES = [
  { value: "hub-protocol.read", label: "Hub: Read", group: "Hub" },
  { value: "hub-protocol.write", label: "Hub: Write", group: "Hub" },
  { value: "hub-protocol.admin", label: "Hub: Admin", group: "Hub" },
  { value: "data.read", label: "Data: Read", group: "Data" },
  { value: "data.write", label: "Data: Write", group: "Data" },
  { value: "mcp.connect", label: "MCP: Connect", group: "MCP" },
];

function KeyPrefix({ prefix }: { prefix: string }) {
  return (
    <Code
      style={{
        fontFamily: typography.fontFamily.mono,
        fontSize: typography.fontSize.xs,
        color: colors.text.secondary,
      }}
    >
      {prefix}••••
    </Code>
  );
}

function ScopeBadges({ scopes }: { scopes: string[] }) {
  return (
    <Group gap={4}>
      {scopes.map((s) => (
        <Badge key={s} size="xs" variant="light" color="violet">
          {s}
        </Badge>
      ))}
    </Group>
  );
}

function SectionHeader({ title, color }: { title: string; color: string }) {
  return (
    <div
      style={{
        fontSize: typography.fontSize.sm,
        fontWeight: typography.fontWeight.semibold,
        color,
        marginBottom: spacing[3],
        paddingBottom: spacing[2],
        borderBottom: `2px solid ${color}30`,
      }}
    >
      {title}
    </div>
  );
}

export default function ApiKeysPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState<number | string>("");

  const { data: myKeys, isLoading: myKeysLoading, refetch: refetchMy } =
    trpc.apiKeys.list.useQuery();

  const { data: systemKeys, isLoading: systemKeysLoading, refetch: refetchSystem } =
    trpc.apiKeys.listSystemKeys.useQuery();

  const createMutation = trpc.apiKeys.create.useMutation({
    onSuccess: (data) => {
      setNewKey(data.key);
      refetchMy();
      refetchSystem();
      showSuccessNotification({ message: "API key created successfully" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const revokeMutation = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      refetchMy();
      refetchSystem();
      showSuccessNotification({ message: "Key revoked" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const rotateMutation = trpc.apiKeys.rotate.useMutation({
    onSuccess: () => {
      refetchMy();
      refetchSystem();
      showSuccessNotification({ message: "Key rotated — get new key from the response" });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  function handleCreate() {
    if (!keyName.trim() || scopes.length === 0) return;
    createMutation.mutate({
      keyName: keyName.trim(),
      scope: scopes,
      expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
    });
  }

  function handleCloseCreate() {
    setCreateOpen(false);
    setNewKey(null);
    setKeyName("");
    setScopes([]);
    setExpiresInDays("");
  }

  function formatDate(d: Date | null | undefined) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString();
  }

  const isHubKey = (prefix: string) =>
    prefix.startsWith("synap_hub_");

  const allKeys = [
    ...(systemKeys ?? []),
    ...(myKeys ?? []).filter((k) => !systemKeys?.find((s) => s.id === k.id)),
  ];

  const hubKeys = allKeys.filter((k) => isHubKey(k.keyPrefix));
  const userKeys = allKeys.filter((k) => !isHubKey(k.keyPrefix));

  const isLoading = myKeysLoading || systemKeysLoading;

  function KeyRow({
    k,
    accent,
  }: {
    k: NonNullable<typeof allKeys>[number];
    accent: string;
  }) {
    return (
      <Table.Tr key={k.id}>
        <Table.Td>
          <Text size="sm" fw={500}>
            {k.keyName}
          </Text>
        </Table.Td>
        <Table.Td>
          <KeyPrefix prefix={k.keyPrefix} />
        </Table.Td>
        <Table.Td>
          <ScopeBadges scopes={k.scope} />
        </Table.Td>
        <Table.Td>
          <Text size="sm" c="dimmed">
            {k.usageCount}
          </Text>
        </Table.Td>
        <Table.Td>
          <Text size="sm" c="dimmed">
            {formatDate(k.lastUsedAt)}
          </Text>
        </Table.Td>
        <Table.Td>
          {k.isActive ? (
            <Badge size="xs" color="green">
              Active
            </Badge>
          ) : (
            <Badge size="xs" color="red">
              Revoked
            </Badge>
          )}
        </Table.Td>
        <Table.Td>
          <Group gap={4}>
            {k.isActive && (
              <>
                <Tooltip label="Rotate key">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="blue"
                    loading={rotateMutation.isPending}
                    onClick={() => rotateMutation.mutate({ keyId: k.id })}
                  >
                    <IconRefresh size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Revoke key">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    loading={revokeMutation.isPending}
                    onClick={() => revokeMutation.mutate({ keyId: k.id })}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              </>
            )}
          </Group>
        </Table.Td>
      </Table.Tr>
    );
  }

  return (
    <div style={{ padding: spacing[6] }}>
      {/* Header */}
      <Group justify="space-between" mb={spacing[6]}>
        <div>
          <Group gap="sm" mb={spacing[1]}>
            <IconKey size={22} color={colors.eventTypes.created} />
            <Text size="xl" fw={700}>
              API Keys
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            Manage authentication keys for Hub Protocol, Data, and MCP access.
          </Text>
        </div>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => setCreateOpen(true)}
          color="violet"
        >
          Create Key
        </Button>
      </Group>

      {isLoading ? (
        <Loader />
      ) : (
        <Stack gap={spacing[8]}>
          {/* Hub Protocol Keys */}
          {hubKeys.length > 0 && (
            <div>
              <SectionHeader
                title="Hub Protocol Keys"
                color={colors.semantic.warning}
              />
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Prefix</Table.Th>
                    <Table.Th>Scopes</Table.Th>
                    <Table.Th>Usage</Table.Th>
                    <Table.Th>Last Used</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Actions</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {hubKeys.map((k) => (
                    <KeyRow key={k.id} k={k} accent={colors.semantic.warning} />
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}

          {/* User Keys */}
          {userKeys.length > 0 && (
            <div>
              <SectionHeader title="User Keys" color={colors.semantic.info} />
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Prefix</Table.Th>
                    <Table.Th>Scopes</Table.Th>
                    <Table.Th>Usage</Table.Th>
                    <Table.Th>Last Used</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Actions</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {userKeys.map((k) => (
                    <KeyRow key={k.id} k={k} accent={colors.semantic.info} />
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}

          {hubKeys.length === 0 && userKeys.length === 0 && (
            <Text c="dimmed" ta="center" py={spacing[10]}>
              No API keys found. Create your first key to get started.
            </Text>
          )}
        </Stack>
      )}

      {/* Create Key Modal */}
      <Modal
        opened={createOpen}
        onClose={handleCloseCreate}
        title={
          <Text fw={600} size="lg">
            Create API Key
          </Text>
        }
        size="md"
      >
        {newKey ? (
          <Stack gap={spacing[4]}>
            <Alert
              icon={<IconAlertCircle size={16} />}
              color="yellow"
              title="Save this key now"
            >
              This key will only be shown once. Copy it before closing.
            </Alert>
            <Code
              block
              style={{
                fontFamily: typography.fontFamily.mono,
                fontSize: typography.fontSize.sm,
                padding: spacing[4],
                backgroundColor: `${colors.semantic.warning}10`,
                border: `1px solid ${colors.semantic.warning}40`,
                color: colors.semantic.warning,
                wordBreak: "break-all",
              }}
            >
              {newKey}
            </Code>
            <Button
              leftSection={<IconCopy size={16} />}
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(newKey);
                showSuccessNotification({ message: "Key copied to clipboard" });
              }}
            >
              Copy Key
            </Button>
            <Button onClick={handleCloseCreate} fullWidth>
              Done
            </Button>
          </Stack>
        ) : (
          <Stack gap={spacing[4]}>
            <TextInput
              label="Key Name"
              placeholder="e.g. Production Hub Key"
              value={keyName}
              onChange={(e) => setKeyName(e.currentTarget.value)}
              required
            />
            <MultiSelect
              label="Scopes"
              placeholder="Select permissions"
              data={HUB_SCOPES}
              value={scopes}
              onChange={setScopes}
              required
            />
            <NumberInput
              label="Expires in days (optional)"
              placeholder="Leave blank for no expiry"
              value={expiresInDays}
              onChange={setExpiresInDays}
              min={1}
              max={3650}
            />
            <Button
              onClick={handleCreate}
              loading={createMutation.isPending}
              disabled={!keyName.trim() || scopes.length === 0}
              fullWidth
            >
              Create Key
            </Button>
          </Stack>
        )}
      </Modal>
    </div>
  );
}

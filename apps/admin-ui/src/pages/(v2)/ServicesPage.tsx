/**
 * Services Page
 *
 * Manages external agent service provisioning for the current workspace.
 * Each service (OpenClaw, ZeroClaw, …) is represented as a card showing
 * current status and providing provision / rotate-key / deprovision actions.
 */

import { useState } from "react";
import {
  Text,
  Badge,
  Modal,
  Alert,
  Button,
  Stack,
  Group,
  Loader,
  ActionIcon,
  Tooltip,
  Card,
  Divider,
  ThemeIcon,
  CopyButton,
  Code,
  ScrollArea,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconCheck,
  IconCopy,
  IconPlug,
  IconPlugOff,
  IconRefresh,
  IconRobot,
  IconTerminal2,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing, typography, borderRadius } from "../../theme/tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Service catalog (mirrors backend catalog, display-only)
// ─────────────────────────────────────────────────────────────────────────────

interface ServiceMeta {
  serviceType: string;
  displayName: string;
  description: string;
  capabilities: string[];
  color: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
  envVarPrefix: string; // e.g. "SYNAP"
}

const SERVICE_META: ServiceMeta[] = [
  {
    serviceType: "openclaw",
    displayName: "OpenClaw",
    description:
      "World-interface agent: shell, browser, filesystem, Telegram, WhatsApp, Slack. Runs as a Docker container and registers itself via Hub Protocol.",
    capabilities: ["shell", "browser", "filesystem", "messaging", "channels"],
    color: "orange",
    icon: IconRobot,
    envVarPrefix: "SYNAP",
  },
  {
    serviceType: "zeroclaw",
    displayName: "ZeroClaw",
    description:
      "LLM inference agent: serves local or remote language models and registers its capabilities via Hub Protocol.",
    capabilities: ["llm", "inference"],
    color: "violet",
    icon: IconTerminal2,
    envVarPrefix: "SYNAP",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Credential reveal modal (shown once after provision or key rotation)
// ─────────────────────────────────────────────────────────────────────────────

interface CredentialsModalProps {
  opened: boolean;
  onClose: () => void;
  serviceType: string;
  displayName: string;
  apiKey: string;
  agentUserId: string;
  workspaceId: string;
  podUrl: string;
  dockerCommand: string;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <Group justify="space-between" gap={spacing[2]} align="flex-start">
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Text
          size="xs"
          c="dimmed"
          fw={500}
          tt="uppercase"
          style={{ letterSpacing: "0.05em" }}
        >
          {label}
        </Text>
        <Code
          block={false}
          style={{
            fontFamily: typography.fontFamily.mono,
            fontSize: typography.fontSize.xs,
            wordBreak: "break-all",
            display: "block",
          }}
        >
          {value}
        </Code>
      </Stack>
      <CopyButton value={value} timeout={1500}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied!" : "Copy"} withArrow>
            <ActionIcon
              variant="subtle"
              color={copied ? "teal" : "gray"}
              size="sm"
              onClick={copy}
              style={{ flexShrink: 0, marginTop: 18 }}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

function CredentialsModal({
  opened,
  onClose,
  displayName,
  apiKey,
  agentUserId,
  workspaceId,
  podUrl,
  dockerCommand,
}: CredentialsModalProps) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap={spacing[2]}>
          <IconCheck size={18} color="teal" />
          <Text fw={600} size="lg">
            {displayName} provisioned
          </Text>
        </Group>
      }
      size="lg"
    >
      <Stack gap={spacing[4]}>
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="orange"
          variant="light"
          title="Save your API key now"
        >
          The API key below is shown <strong>only once</strong>. It cannot be
          retrieved again — use Rotate Key if you lose it.
        </Alert>

        {/* Environment variables */}
        <div>
          <Text fw={600} size="sm" mb={spacing[3]}>
            Environment variables
          </Text>
          <Stack gap={spacing[2]}>
            <CopyRow label="SYNAP_POD_URL" value={podUrl} />
            <CopyRow label="SYNAP_HUB_API_KEY" value={apiKey} />
            <CopyRow label="SYNAP_WORKSPACE_ID" value={workspaceId} />
            <CopyRow label="SYNAP_AGENT_USER_ID" value={agentUserId} />
          </Stack>
        </div>

        <Divider />

        {/* Docker command */}
        <div>
          <Group justify="space-between" mb={spacing[2]}>
            <Text fw={600} size="sm">
              Docker run command
            </Text>
            <CopyButton value={dockerCommand} timeout={1500}>
              {({ copied, copy }) => (
                <Button
                  variant="subtle"
                  size="xs"
                  leftSection={
                    copied ? <IconCheck size={12} /> : <IconCopy size={12} />
                  }
                  color={copied ? "teal" : "gray"}
                  onClick={copy}
                >
                  {copied ? "Copied!" : "Copy command"}
                </Button>
              )}
            </CopyButton>
          </Group>
          <ScrollArea>
            <Code
              block
              style={{
                fontFamily: typography.fontFamily.mono,
                fontSize: typography.fontSize.xs,
                whiteSpace: "pre",
              }}
            >
              {dockerCommand}
            </Code>
          </ScrollArea>
        </div>

        <Button onClick={onClose} fullWidth variant="light">
          Done — I've saved my credentials
        </Button>
      </Stack>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Single service card
// ─────────────────────────────────────────────────────────────────────────────

interface ProvisionedInfo {
  agentUserId: string;
  apiKey: string;
  podUrl: string;
  dockerCommand: string;
  workspaceId: string;
}

interface ServiceCardProps {
  meta: ServiceMeta;
  workspaceId: string;
}

function ServiceCard({ meta, workspaceId }: ServiceCardProps) {
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [revealed, setRevealed] = useState<ProvisionedInfo | null>(null);

  const statusQuery = trpc.intelligenceRegistry.getAgentStatus.useQuery(
    { serviceType: meta.serviceType },
    { retry: false }
  );

  const provisionMutation =
    trpc.intelligenceRegistry.provisionAgent.useMutation({
      onSuccess: (data) => {
        statusQuery.refetch();
        if (data.status === "already_provisioned") {
          showSuccessNotification({
            message: `${meta.displayName} is already provisioned`,
          });
          return;
        }
        if (data.apiKey) {
          setRevealed({
            agentUserId: data.agentUserId,
            apiKey: data.apiKey,
            podUrl: data.podUrl,
            dockerCommand: data.dockerCommand,
            workspaceId: data.workspaceId,
          });
          setCredentialsOpen(true);
        }
      },
      onError: (err) => showErrorNotification({ message: err.message }),
    });

  const deprovisionMutation =
    trpc.intelligenceRegistry.deprovisionAgent.useMutation({
      onSuccess: () => {
        statusQuery.refetch();
        showSuccessNotification({
          message: `${meta.displayName} deprovisioned`,
        });
      },
      onError: (err) => showErrorNotification({ message: err.message }),
    });

  const rotateMutation = trpc.intelligenceRegistry.rotateAgentKey.useMutation({
    onSuccess: (data) => {
      statusQuery.refetch();
      setRevealed({
        agentUserId: statusQuery.data?.agentUserId ?? "",
        apiKey: data.apiKey,
        podUrl: statusQuery.data?.podUrl ?? "",
        dockerCommand: data.dockerCommand,
        workspaceId,
      });
      setCredentialsOpen(true);
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const status = statusQuery.data;
  const isLoading = statusQuery.isLoading;
  const isMutating =
    provisionMutation.isPending ||
    deprovisionMutation.isPending ||
    rotateMutation.isPending;

  const Icon = meta.icon;

  // Status badge
  let statusBadge: React.ReactNode;
  let statusIcon: React.ReactNode;
  if (isLoading) {
    statusBadge = (
      <Badge size="sm" color="gray">
        Checking…
      </Badge>
    );
    statusIcon = <IconCircleDashed size={16} color={colors.text.tertiary} />;
  } else if (!status?.provisioned) {
    statusBadge = (
      <Badge size="sm" color="gray" variant="outline">
        Not provisioned
      </Badge>
    );
    statusIcon = <IconCircleX size={16} color={colors.text.tertiary} />;
  } else if (status.serviceRegistered) {
    statusBadge = (
      <Badge size="sm" color="teal">
        Connected
      </Badge>
    );
    statusIcon = <IconCircleCheck size={16} color="teal" />;
  } else {
    statusBadge = (
      <Badge size="sm" color="blue" variant="light">
        Provisioned
      </Badge>
    );
    statusIcon = <IconCircleCheck size={16} color="dodgerblue" />;
  }

  return (
    <>
      <Card
        padding={spacing[5]}
        radius={borderRadius.lg}
        style={{
          border: `1px solid ${status?.provisioned ? colors.border.interactive : colors.border.default}`,
          backgroundColor: colors.background.primary,
        }}
      >
        {/* Header */}
        <Group justify="space-between" mb={spacing[3]}>
          <Group gap={spacing[3]}>
            <ThemeIcon size="lg" variant="light" color={meta.color} radius="md">
              <Icon size={20} />
            </ThemeIcon>
            <div>
              <Text fw={700} size="sm">
                {meta.displayName}
              </Text>
              <Group gap={4} mt={2}>
                {statusIcon}
                {statusBadge}
                {status?.mcpApproved && (
                  <Badge size="xs" color="grape" variant="dot">
                    MCP
                  </Badge>
                )}
              </Group>
            </div>
          </Group>
          {isLoading && <Loader size="xs" />}
        </Group>

        {/* Description */}
        <Text size="sm" c="dimmed" mb={spacing[3]} style={{ lineHeight: 1.5 }}>
          {meta.description}
        </Text>

        {/* Capabilities */}
        <Group gap={4} mb={spacing[4]}>
          {meta.capabilities.map((cap) => (
            <Badge key={cap} size="xs" variant="light" color="cyan">
              {cap}
            </Badge>
          ))}
        </Group>

        {/* Runtime info (when provisioned) */}
        {status?.provisioned && (
          <div
            style={{
              backgroundColor: colors.background.secondary,
              borderRadius: borderRadius.md,
              padding: `${spacing[2]} ${spacing[3]}`,
              marginBottom: spacing[3],
              border: `1px solid ${colors.border.light}`,
            }}
          >
            <Group gap={spacing[4]}>
              <div>
                <Text size="xs" c="dimmed" fw={500}>
                  Agent ID
                </Text>
                <Text
                  size="xs"
                  style={{ fontFamily: typography.fontFamily.mono }}
                >
                  {status.agentUserId?.slice(0, 16)}…
                </Text>
              </div>
              {status.mcpEndpoint && (
                <div>
                  <Text size="xs" c="dimmed" fw={500}>
                    MCP endpoint
                  </Text>
                  <Text
                    size="xs"
                    style={{ fontFamily: typography.fontFamily.mono }}
                  >
                    {status.mcpEndpoint}
                  </Text>
                </div>
              )}
            </Group>
          </div>
        )}

        <Divider mb={spacing[3]} />

        {/* Actions */}
        <Group gap={spacing[2]}>
          {!status?.provisioned ? (
            <Button
              size="xs"
              color={meta.color}
              leftSection={<IconPlug size={14} />}
              loading={provisionMutation.isPending}
              disabled={isMutating || isLoading}
              onClick={() =>
                provisionMutation.mutate({ serviceType: meta.serviceType })
              }
            >
              Provision
            </Button>
          ) : (
            <>
              <Tooltip label="Revoke current key and issue a new one" withArrow>
                <Button
                  size="xs"
                  variant="light"
                  color="blue"
                  leftSection={<IconRefresh size={14} />}
                  loading={rotateMutation.isPending}
                  disabled={isMutating}
                  onClick={() =>
                    rotateMutation.mutate({ serviceType: meta.serviceType })
                  }
                >
                  Rotate Key
                </Button>
              </Tooltip>
              <Tooltip label="Remove agent user and revoke all keys" withArrow>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  leftSection={<IconPlugOff size={14} />}
                  loading={deprovisionMutation.isPending}
                  disabled={isMutating}
                  onClick={() => {
                    if (
                      confirm(
                        `Deprovision ${meta.displayName}? This will revoke all API keys and delete the agent user.`
                      )
                    ) {
                      deprovisionMutation.mutate({
                        serviceType: meta.serviceType,
                      });
                    }
                  }}
                >
                  Deprovision
                </Button>
              </Tooltip>
            </>
          )}
        </Group>
      </Card>

      {/* Credentials modal (shown once after provision or rotate) */}
      {revealed && (
        <CredentialsModal
          opened={credentialsOpen}
          onClose={() => {
            setCredentialsOpen(false);
            setRevealed(null);
          }}
          serviceType={meta.serviceType}
          displayName={meta.displayName}
          apiKey={revealed.apiKey}
          agentUserId={revealed.agentUserId}
          workspaceId={revealed.workspaceId}
          podUrl={revealed.podUrl}
          dockerCommand={revealed.dockerCommand}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function ServicesPage() {
  const { workspaceId } = useWorkspace();

  if (!workspaceId) {
    return (
      <div style={{ padding: spacing[6] }}>
        <Text c="dimmed">Select a workspace to manage services.</Text>
      </div>
    );
  }

  return (
    <div style={{ padding: spacing[6] }}>
      {/* Header */}
      <Group mb={spacing[2]}>
        <ThemeIcon size="lg" variant="light" color="teal" radius="md">
          <IconPlug size={20} />
        </ThemeIcon>
        <div>
          <Text size="xl" fw={700}>
            External Services
          </Text>
          <Text size="sm" c="dimmed">
            Provision and manage agent containers that connect to this workspace
            via Hub Protocol.
          </Text>
        </div>
      </Group>

      <Divider mb={spacing[6]} />

      {/* How it works */}
      <Alert
        icon={<IconTerminal2 size={16} />}
        color="blue"
        variant="light"
        mb={spacing[5]}
        title="How it works"
      >
        Provisioning creates a dedicated AI agent user + Hub Protocol API key
        for the service. Copy the generated credentials into your container's
        environment variables. The container will self-register its capabilities
        once it starts.
      </Alert>

      {/* Service cards — 2-column grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
          gap: spacing[4],
        }}
      >
        {SERVICE_META.map((meta) => (
          <ServiceCard
            key={meta.serviceType}
            meta={meta}
            workspaceId={workspaceId}
          />
        ))}
      </div>
    </div>
  );
}

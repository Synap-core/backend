/**
 * Services Page — external agent service provisioning for the workspace.
 */

import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  Modal,
  Separator,
  Spinner,
  Text,
  Tooltip,
  useOverlayState,
} from "@heroui/react";
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
  IconLock,
  IconDownload,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing, typography, borderRadius } from "../../theme/tokens";

interface ServiceMeta {
  serviceType: string;
  displayName: string;
  description: string;
  capabilities: string[];
  color: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
  envVarPrefix: string;
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

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className="flex items-start justify-between gap-2"
      style={{ gap: spacing[2] }}
    >
      <div className="min-w-0 flex-1">
        <Text
          className="text-xs font-medium uppercase tracking-wide text-default-500"
          style={{ letterSpacing: "0.05em" }}
        >
          {label}
        </Text>
        <code
          className="mt-1 block break-all text-xs text-foreground"
          style={{ fontFamily: typography.fontFamily.mono }}
        >
          {value}
        </code>
      </div>
      <Tooltip>
        <Tooltip.Trigger>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            className="mt-4 shrink-0"
            onPress={copy}
            aria-label="Copy"
          >
            {copied ? (
              <IconCheck size={14} className="text-success" />
            ) : (
              <IconCopy size={14} />
            )}
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>{copied ? "Copied!" : "Copy"}</Tooltip.Content>
      </Tooltip>
    </div>
  );
}

function VaultCredentialsModal({
  state,
  displayName,
  apiKey,
  configUrl,
}: {
  state: ReturnType<typeof useOverlayState>;
  displayName: string;
  apiKey: string;
  configUrl: string;
}) {
  return (
    <Modal state={state}>
      <Modal.Backdrop isDismissable />
      <Modal.Container size="lg" placement="center">
        <Modal.Dialog>
          <Modal.Header className="flex flex-col gap-1 border-b border-divider px-6 py-4">
            <div className="flex items-center gap-2">
              <IconCheck size={18} className="text-success" />
              <Modal.Heading className="text-lg font-semibold">
                {displayName} provisioned
              </Modal.Heading>
            </div>
            <Modal.CloseTrigger className="absolute right-3 top-3" />
          </Modal.Header>
          <Modal.Body className="gap-4 px-6 py-4">
            <Alert status="success">
              <Alert.Indicator>
                <IconLock size={16} />
              </Alert.Indicator>
              <Alert.Content>
                <Alert.Title>Credentials secured in your vault</Alert.Title>
                <Alert.Description>
                  All configuration has been stored in your workspace vault and
                  encrypted at rest. The service will pull its full config
                  automatically on startup — no manual copy-paste required.
                </Alert.Description>
              </Alert.Content>
            </Alert>

            <div>
              <Text className="mb-1 text-sm font-semibold">
                Bootstrap environment variables
              </Text>
              <Text
                className="mb-3 text-xs text-default-500"
                style={{ marginBottom: spacing[3] }}
              >
                Set these two variables in your container. The service fetches
                all remaining config from the vault via{" "}
                <code
                  className="rounded bg-default-100 px-1 text-xs"
                  style={{ fontFamily: typography.fontFamily.mono }}
                >
                  SYNAP_CONFIG_URL
                </code>{" "}
                on startup.
              </Text>
              <div className="flex flex-col gap-2" style={{ gap: spacing[2] }}>
                <CopyRow label="SYNAP_HUB_API_KEY" value={apiKey} />
                <CopyRow label="SYNAP_CONFIG_URL" value={configUrl} />
              </div>
            </div>

            <Separator />

            <div>
              <div
                className="mb-2 flex items-center gap-2"
                style={{ marginBottom: spacing[2] }}
              >
                <IconDownload size={14} color={colors.text.tertiary} />
                <Text className="text-sm font-semibold">
                  Auto-fetched from vault on startup
                </Text>
              </div>
              <Text className="text-xs leading-relaxed text-default-500">
                <code
                  className="rounded bg-default-100 px-1 text-xs"
                  style={{ fontFamily: typography.fontFamily.mono }}
                >
                  SYNAP_POD_URL
                </code>
                ,{" "}
                <code
                  className="rounded bg-default-100 px-1 text-xs"
                  style={{ fontFamily: typography.fontFamily.mono }}
                >
                  SYNAP_WORKSPACE_ID
                </code>
                ,{" "}
                <code
                  className="rounded bg-default-100 px-1 text-xs"
                  style={{ fontFamily: typography.fontFamily.mono }}
                >
                  SYNAP_AGENT_USER_ID
                </code>{" "}
                — no longer needed in your environment.
              </Text>
            </div>

            <Alert status="warning">
              <Alert.Indicator>
                <IconAlertCircle size={16} />
              </Alert.Indicator>
              <Alert.Content>
                <Alert.Title>Save SYNAP_HUB_API_KEY now</Alert.Title>
                <Alert.Description>
                  The API key above is shown only once. Use Rotate Key if you
                  lose it. The config URL can be retrieved again from the vault.
                </Alert.Description>
              </Alert.Content>
            </Alert>

            <Button variant="ghost" fullWidth onPress={() => state.close()}>
              Done
            </Button>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal>
  );
}

interface ProvisionedInfo {
  apiKey: string;
  configUrl: string;
}

interface ServiceCardProps {
  meta: ServiceMeta;
  workspaceId: string;
}

function ServiceCard({ meta }: ServiceCardProps) {
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [revealed, setRevealed] = useState<ProvisionedInfo | null>(null);

  const credModal = useOverlayState({
    isOpen: credentialsOpen,
    onOpenChange: (open) => {
      setCredentialsOpen(open);
      if (!open) setRevealed(null);
    },
  });

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
            apiKey: data.apiKey,
            configUrl: data.configUrl ?? "",
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
        apiKey: data.apiKey,
        configUrl: data.configUrl ?? "",
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

  let statusBadge: React.ReactNode;
  let statusIcon: React.ReactNode;
  if (isLoading) {
    statusBadge = (
      <Chip size="sm" variant="soft" color="default">
        Checking…
      </Chip>
    );
    statusIcon = <IconCircleDashed size={16} color={colors.text.tertiary} />;
  } else if (!status?.provisioned) {
    statusBadge = (
      <Chip size="sm" variant="soft" color="default">
        Not provisioned
      </Chip>
    );
    statusIcon = <IconCircleX size={16} color={colors.text.tertiary} />;
  } else if (status.serviceRegistered) {
    statusBadge = (
      <Chip size="sm" variant="soft" color="success">
        Connected
      </Chip>
    );
    statusIcon = <IconCircleCheck size={16} className="text-success" />;
  } else {
    statusBadge = (
      <Chip size="sm" variant="soft" color="accent">
        Provisioned
      </Chip>
    );
    statusIcon = <IconCircleCheck size={16} className="text-accent" />;
  }

  return (
    <>
      <Card
        className="border border-divider p-5"
        style={{
          borderRadius: borderRadius.lg,
          borderColor: status?.provisioned
            ? colors.border.interactive
            : colors.border.default,
          backgroundColor: colors.background.primary,
        }}
      >
        <div
          className="mb-3 flex items-start justify-between gap-3"
          style={{ marginBottom: spacing[3] }}
        >
          <div className="flex items-start gap-3">
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${
                meta.color === "orange"
                  ? "bg-warning/15 text-warning"
                  : "bg-accent/15 text-accent"
              }`}
            >
              <Icon size={20} />
            </div>
            <div>
              <Text className="text-sm font-bold">{meta.displayName}</Text>
              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                {statusIcon}
                {statusBadge}
                {status?.mcpApproved ? (
                  <Chip size="sm" variant="soft" color="warning">
                    MCP
                  </Chip>
                ) : null}
              </div>
            </div>
          </div>
          {isLoading ? <Spinner size="sm" color="accent" /> : null}
        </div>

        <Text
          className="mb-3 text-sm text-default-500"
          style={{ marginBottom: spacing[3], lineHeight: 1.5 }}
        >
          {meta.description}
        </Text>

        <div
          className="mb-4 flex flex-wrap gap-1"
          style={{ marginBottom: spacing[4] }}
        >
          {meta.capabilities.map((cap) => (
            <Chip key={cap} size="sm" variant="soft" color="accent">
              {cap}
            </Chip>
          ))}
        </div>

        {status?.provisioned ? (
          <div
            className="mb-3 border border-divider"
            style={{
              backgroundColor: colors.background.secondary,
              borderRadius: borderRadius.md,
              padding: `${spacing[2]} ${spacing[3]}`,
              marginBottom: spacing[3],
            }}
          >
            <div className="flex flex-wrap gap-4" style={{ gap: spacing[4] }}>
              <div>
                <Text className="text-xs font-medium text-default-500">
                  Agent ID
                </Text>
                <Text
                  className="text-xs"
                  style={{ fontFamily: typography.fontFamily.mono }}
                >
                  {status.agentUserId?.slice(0, 16)}…
                </Text>
              </div>
              {status.mcpEndpoint ? (
                <div>
                  <Text className="text-xs font-medium text-default-500">
                    MCP endpoint
                  </Text>
                  <Text
                    className="text-xs"
                    style={{ fontFamily: typography.fontFamily.mono }}
                  >
                    {status.mcpEndpoint}
                  </Text>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <Separator className="mb-3" />

        <div className="flex flex-wrap gap-2" style={{ gap: spacing[2] }}>
          {!status?.provisioned ? (
            <Button
              size="sm"
              variant="primary"
              isDisabled={isMutating || isLoading}
              onPress={() =>
                provisionMutation.mutate({ serviceType: meta.serviceType })
              }
            >
              {provisionMutation.isPending ? (
                <Spinner size="sm" color="current" />
              ) : (
                <span className="inline-flex items-center gap-1">
                  <IconPlug size={14} />
                  Provision
                </span>
              )}
            </Button>
          ) : (
            <>
              <Tooltip>
                <Tooltip.Trigger>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={isMutating}
                    onPress={() =>
                      rotateMutation.mutate({ serviceType: meta.serviceType })
                    }
                  >
                    {rotateMutation.isPending ? (
                      <Spinner size="sm" color="current" />
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <IconRefresh size={14} />
                        Rotate Key
                      </span>
                    )}
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Content>
                  Revoke current key and issue a new one
                </Tooltip.Content>
              </Tooltip>
              <Tooltip>
                <Tooltip.Trigger>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    isDisabled={isMutating}
                    onPress={() => {
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
                    {deprovisionMutation.isPending ? (
                      <Spinner size="sm" color="current" />
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <IconPlugOff size={14} />
                        Deprovision
                      </span>
                    )}
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Content>
                  Remove agent user and revoke all keys
                </Tooltip.Content>
              </Tooltip>
            </>
          )}
        </div>
      </Card>

      {revealed ? (
        <VaultCredentialsModal
          state={credModal}
          displayName={meta.displayName}
          apiKey={revealed.apiKey}
          configUrl={revealed.configUrl}
        />
      ) : null}
    </>
  );
}

export default function ServicesPage() {
  const { workspaceId } = useWorkspace();

  if (!workspaceId) {
    return (
      <div style={{ padding: spacing[6] }}>
        <Text className="text-default-500">
          Select a workspace to manage services.
        </Text>
      </div>
    );
  }

  return (
    <div style={{ padding: spacing[6] }}>
      <div className="mb-2 flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-success/15 text-success">
          <IconPlug size={20} />
        </div>
        <div>
          <Text className="text-xl font-bold">External Services</Text>
          <Text className="text-sm text-default-500">
            Provision and manage agent containers that connect to this workspace
            via Hub Protocol.
          </Text>
        </div>
      </div>

      <Separator className="mb-6" />

      <Alert status="success" className="mb-5">
        <Alert.Indicator>
          <IconLock size={16} />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>How it works</Alert.Title>
          <Alert.Description>
            Provisioning creates a dedicated AI agent user + Hub Protocol API
            key, then stores all configuration encrypted in your workspace
            vault. Set just two bootstrap variables (
            <code className="text-xs">SYNAP_HUB_API_KEY</code> +{" "}
            <code className="text-xs">SYNAP_CONFIG_URL</code>) in your container
            — the service pulls the rest automatically on startup.
          </Alert.Description>
        </Alert.Content>
      </Alert>

      <div
        className="grid gap-4"
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

import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Chip,
  Spinner,
  Tabs,
  Text,
  Tooltip,
} from "@heroui/react";
import {
  IconBrandOpenai,
  IconCircleCheck,
  IconCircleX,
  IconExternalLink,
  IconFlask2,
  IconKey,
  IconPlayerPlay,
  IconRefresh,
  IconRotate,
  IconServerCog,
  IconTool,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";
import {
  showErrorNotification,
  showInfoNotification,
  showSuccessNotification,
} from "../../lib/notifications";

type OpenClawTab =
  | "overview"
  | "onboarding"
  | "operations"
  | "monitoring"
  | "troubleshooting";

export default function OpenClawControlCenterPage() {
  const { workspaceId, workspaceName, workspaces, setWorkspace } =
    useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [lastKey, setLastKey] = useState<string | null>(null);

  const tab = useMemo<OpenClawTab>(() => {
    if (location.pathname.endsWith("/onboarding")) return "onboarding";
    if (location.pathname.endsWith("/operations")) return "operations";
    if (location.pathname.endsWith("/monitoring")) return "monitoring";
    if (location.pathname.endsWith("/troubleshooting"))
      return "troubleshooting";
    return "overview";
  }, [location.pathname]);

  const overviewQuery = trpc.openclawAdmin.getOverview.useQuery(undefined, {
    refetchInterval: 30_000,
  });
  const hostedUiQuery = trpc.openclawAdmin.getHostedUiLink.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const provisionMutation =
    trpc.intelligenceRegistry.provisionAgent.useMutation({
      onSuccess: (data) => {
        void overviewQuery.refetch();
        if (data.status === "already_provisioned") {
          showInfoNotification({ message: "OpenClaw is already provisioned." });
          return;
        }
        if (data.apiKey) {
          setLastKey(data.apiKey);
          showSuccessNotification({
            message: "OpenClaw provisioned. Save the generated key now.",
          });
        } else {
          showSuccessNotification({
            message: "OpenClaw provisioned. Vault bootstrap is ready.",
          });
        }
      },
      onError: (err) => showErrorNotification({ message: err.message }),
    });

  const rotateMutation = trpc.intelligenceRegistry.rotateAgentKey.useMutation({
    onSuccess: (data) => {
      setLastKey(data.apiKey);
      void overviewQuery.refetch();
      showSuccessNotification({
        message: "OpenClaw key rotated successfully.",
      });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const validateMutation = trpc.openclawAdmin.validateConnection.useMutation({
    onSuccess: (data) => {
      void overviewQuery.refetch();
      if (data.ok) {
        showSuccessNotification({
          message: "OpenClaw health check is healthy.",
        });
      } else {
        showErrorNotification({
          message: data.message ?? "Health check failed.",
        });
      }
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const diagnosticsMutation = trpc.openclawAdmin.runDiagnostics.useMutation({
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const runtimeMutation = trpc.openclawAdmin.runRuntimeAction.useMutation({
    onSuccess: (data) => {
      showInfoNotification({
        message: `${data.action} is manual today. Commands listed in Operations.`,
      });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const data = overviewQuery.data;
  const openclaw = data?.openclaw;
  const isBusy =
    provisionMutation.isPending ||
    rotateMutation.isPending ||
    validateMutation.isPending ||
    diagnosticsMutation.isPending ||
    runtimeMutation.isPending;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <IconBrandOpenai size={24} className="text-primary" />
          <Text className="text-2xl font-semibold">
            OpenClaw control center
          </Text>
        </div>
        <Text className="text-sm text-default-500">
          Hybrid operations: infrastructure via Synap lifecycle, runtime via
          OpenClaw-focused controls. Monitoring is pod-wide, activation is
          workspace-scoped.
        </Text>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Chip size="sm" variant="soft" color="default">
            Scope: Pod-wide monitoring
          </Chip>
          <Chip size="sm" variant="soft" color="accent">
            Scope: Workspace activation
          </Chip>
        </div>
      </header>

      <Card.Root className="border border-divider">
        <Card.Header>
          <Card.Title>Activation target workspace</Card.Title>
          <Card.Description>
            OpenClaw provisioning and key rotation apply to the selected
            workspace.
          </Card.Description>
        </Card.Header>
        <Card.Content className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Text className="text-sm text-default-500">Current target:</Text>
            <Chip
              size="sm"
              variant="soft"
              color={workspaceId ? "success" : "warning"}
            >
              {workspaceId && workspaceName
                ? `${workspaceName} (${workspaceId.slice(0, 8)}...)`
                : "No workspace selected"}
            </Chip>
          </div>
          {workspaces.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {workspaces.map((ws) => (
                <Button
                  key={ws.id}
                  size="sm"
                  variant={workspaceId === ws.id ? "primary" : "outline"}
                  onPress={() => setWorkspace(ws.id)}
                >
                  {ws.name}
                </Button>
              ))}
            </div>
          ) : (
            <Text className="text-sm text-default-500">
              No accessible workspaces found for activation.
            </Text>
          )}
        </Card.Content>
      </Card.Root>

      <Tabs.Root
        selectedKey={tab}
        onSelectionChange={(value) => {
          const key = String(value) as OpenClawTab;
          const route =
            key === "overview" ? "/openclaw" : `/openclaw/${String(key)}`;
          navigate(route);
        }}
      >
        <Tabs.ListContainer>
          <Tabs.List>
            <Tabs.Tab id="overview">Overview</Tabs.Tab>
            <Tabs.Tab id="onboarding">Onboarding</Tabs.Tab>
            <Tabs.Tab id="operations">Operations</Tabs.Tab>
            <Tabs.Tab id="monitoring">Monitoring</Tabs.Tab>
            <Tabs.Tab id="troubleshooting">Troubleshooting</Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs.Root>

      {overviewQuery.isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner color="accent" />
        </div>
      ) : null}

      {tab === "overview" && data ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card.Root className="border border-divider">
            <Card.Header>
              <Card.Title>Runtime status</Card.Title>
              <Card.Description>
                Current OpenClaw runtime posture
              </Card.Description>
            </Card.Header>
            <Card.Content className="space-y-3">
              <StatusLine
                label="Provisioned"
                ok={openclaw?.provisioned ?? false}
                value={openclaw?.provisioned ? "yes" : "no"}
              />
              <StatusLine
                label="Registered"
                ok={openclaw?.registered ?? false}
                value={openclaw?.registered ? "yes" : "no"}
              />
              <StatusLine
                label="Health"
                ok={openclaw?.health.status === "healthy"}
                value={openclaw?.health.status ?? "unknown"}
              />
              <div className="flex flex-wrap gap-2">
                <Chip size="sm" variant="soft" color="default">
                  Version: {openclaw?.version ?? "n/a"}
                </Chip>
                <Chip size="sm" variant="soft" color="default">
                  Active keys: {openclaw?.activeHubKeys ?? 0}
                </Chip>
              </div>
            </Card.Content>
          </Card.Root>

          <Card.Root className="border border-divider">
            <Card.Header>
              <Card.Title>Quick actions</Card.Title>
            </Card.Header>
            <Card.Content className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                isDisabled={isBusy || !workspaceId}
                onPress={() =>
                  provisionMutation.mutate({ serviceType: "openclaw" })
                }
              >
                <span className="inline-flex items-center gap-1">
                  <IconPlayerPlay size={14} />
                  Activate
                </span>
              </Button>
              <Button
                variant="outline"
                isDisabled={isBusy || !workspaceId || !openclaw?.provisioned}
                onPress={() =>
                  rotateMutation.mutate({ serviceType: "openclaw" })
                }
              >
                <span className="inline-flex items-center gap-1">
                  <IconRotate size={14} />
                  Rotate key
                </span>
              </Button>
              <Button
                variant="outline"
                isDisabled={isBusy}
                onPress={() => validateMutation.mutate()}
              >
                <span className="inline-flex items-center gap-1">
                  <IconRefresh size={14} />
                  Validate connection
                </span>
              </Button>
              <Button
                variant="ghost"
                isDisabled={!hostedUiQuery.data?.available}
                onPress={() => {
                  const url = hostedUiQuery.data?.url;
                  if (!url) return;
                  window.open(url, "_blank", "noopener,noreferrer");
                }}
              >
                <span className="inline-flex items-center gap-1">
                  <IconExternalLink size={14} />
                  Open hosted UI
                </span>
              </Button>
            </Card.Content>
          </Card.Root>
        </div>
      ) : null}

      {!workspaceId ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>No workspace selected</Alert.Title>
            <Alert.Description>
              Pod-wide status is available, but activate/rotate actions require
              a workspace context.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {tab === "onboarding" && (
        <Card.Root className="border border-divider">
          <Card.Header>
            <Card.Title>Onboarding workflow</Card.Title>
            <Card.Description>
              Validate {"->"} activate {"->"} configure runtime bootstrap.
            </Card.Description>
          </Card.Header>
          <Card.Content className="space-y-3">
            <Alert status="default">
              <Alert.Indicator>
                <IconTool size={16} />
              </Alert.Indicator>
              <Alert.Content>
                <Alert.Title>Recommended sequence</Alert.Title>
                <Alert.Description>
                  1) Validate connection. 2) Activate OpenClaw (provision
                  agent). 3) Save generated key (or rely on vault bootstrap).
                </Alert.Description>
              </Alert.Content>
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                isDisabled={isBusy}
                onPress={() => validateMutation.mutate()}
              >
                Validate now
              </Button>
              <Button
                variant="primary"
                isDisabled={isBusy}
                onPress={() =>
                  provisionMutation.mutate({ serviceType: "openclaw" })
                }
              >
                Activate OpenClaw
              </Button>
            </div>
            {lastKey ? (
              <Alert status="warning">
                <Alert.Indicator>
                  <IconKey size={16} />
                </Alert.Indicator>
                <Alert.Content>
                  <Alert.Title>Latest generated key (shown once)</Alert.Title>
                  <Alert.Description>
                    <code className="text-xs">{lastKey}</code>
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
          </Card.Content>
        </Card.Root>
      )}

      {tab === "operations" && data ? (
        <Card.Root className="border border-divider">
          <Card.Header>
            <Card.Title>Operations</Card.Title>
            <Card.Description>
              Runtime operations are command-driven today.
            </Card.Description>
          </Card.Header>
          <Card.Content className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                isDisabled={isBusy}
                onPress={() => runtimeMutation.mutate({ action: "restart" })}
              >
                Restart runtime
              </Button>
              <Button
                variant="outline"
                isDisabled={isBusy}
                onPress={() =>
                  runtimeMutation.mutate({ action: "safe_update" })
                }
              >
                Safe update
              </Button>
              <Button
                variant="outline"
                isDisabled={isBusy}
                onPress={() => runtimeMutation.mutate({ action: "rollback" })}
              >
                Rollback
              </Button>
            </div>
            <div className="space-y-2 rounded-medium border border-divider bg-default-50/40 p-3">
              {(data.operations.commands ?? []).map((command) => (
                <CommandRow key={command} command={command} />
              ))}
            </div>
          </Card.Content>
        </Card.Root>
      ) : null}

      {tab === "monitoring" && (
        <Card.Root className="border border-divider">
          <Card.Header>
            <Card.Title>Monitoring</Card.Title>
            <Card.Description>
              Runtime health and diagnostics from backend checks.
            </Card.Description>
          </Card.Header>
          <Card.Content className="space-y-3">
            <Button
              variant="outline"
              isDisabled={isBusy}
              onPress={() => diagnosticsMutation.mutate()}
            >
              <span className="inline-flex items-center gap-1">
                <IconFlask2 size={14} />
                Run diagnostics
              </span>
            </Button>
            {diagnosticsMutation.data ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <StatusLine
                  label="Agent provisioned"
                  ok={diagnosticsMutation.data.checks.agentProvisioned}
                  value={
                    diagnosticsMutation.data.checks.agentProvisioned
                      ? "yes"
                      : "no"
                  }
                />
                <StatusLine
                  label="Service registered"
                  ok={diagnosticsMutation.data.checks.serviceRegistered}
                  value={
                    diagnosticsMutation.data.checks.serviceRegistered
                      ? "yes"
                      : "no"
                  }
                />
                <StatusLine
                  label="Webhook reachable"
                  ok={diagnosticsMutation.data.checks.webhookReachable}
                  value={
                    diagnosticsMutation.data.checks.webhookReachable
                      ? "yes"
                      : "no"
                  }
                />
                <StatusLine
                  label="MCP approved"
                  ok={diagnosticsMutation.data.checks.mcpApproved}
                  value={
                    diagnosticsMutation.data.checks.mcpApproved ? "yes" : "no"
                  }
                />
              </div>
            ) : null}
          </Card.Content>
        </Card.Root>
      )}

      {tab === "troubleshooting" && (
        <Card.Root className="border border-divider">
          <Card.Header>
            <Card.Title>Troubleshooting playbook</Card.Title>
          </Card.Header>
          <Card.Content className="space-y-3">
            <Alert status="warning">
              <Alert.Indicator>
                <IconServerCog size={16} />
              </Alert.Indicator>
              <Alert.Content>
                <Alert.Title>When health is unhealthy</Alert.Title>
                <Alert.Description>
                  Validate connection, run diagnostics, then execute the
                  operations commands in order. If still failing, rotate key and
                  restart.
                </Alert.Description>
              </Alert.Content>
            </Alert>
            <div className="space-y-2 rounded-medium border border-divider bg-default-50/40 p-3">
              <CommandRow command="npx @synap-core/cli openclaw doctor" />
              <CommandRow command="npx @synap-core/cli openclaw logs" />
              <CommandRow command="synap services status openclaw" />
              <CommandRow command="synap services rotate openclaw" />
            </div>
          </Card.Content>
        </Card.Root>
      )}
    </div>
  );
}

function StatusLine({
  label,
  ok,
  value,
}: {
  label: string;
  ok: boolean;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-medium border border-divider bg-default-50/40 px-3 py-2">
      <Text className="text-sm font-medium">{label}</Text>
      <div className="inline-flex items-center gap-2">
        {ok ? (
          <IconCircleCheck size={16} className="text-success" />
        ) : (
          <IconCircleX size={16} className="text-danger" />
        )}
        <Chip size="sm" variant="soft" color={ok ? "success" : "danger"}>
          {value}
        </Chip>
      </div>
    </div>
  );
}

function CommandRow({ command }: { command: string }) {
  return (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          variant="ghost"
          className="w-full justify-start rounded-medium border border-divider bg-background px-3 py-2 text-left text-xs text-foreground hover:bg-default-100"
          onPress={() => {
            void navigator.clipboard.writeText(command);
            showInfoNotification({ message: "Command copied to clipboard." });
          }}
        >
          <code>{command}</code>
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>Click to copy command</Tooltip.Content>
    </Tooltip>
  );
}

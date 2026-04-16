import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Card, Chip, Spinner, Tabs, Text } from "@heroui/react";
import {
  IconBrandTelegram,
  IconCloud,
  IconExternalLink,
  IconKey,
  IconPlugConnected,
  IconRefresh,
  IconRss,
  IconRotate,
  IconShieldCheck,
  IconTrash,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";
import { spacing } from "../../theme/tokens";
import {
  showErrorNotification,
  showSuccessNotification,
} from "../../lib/notifications";
import {
  buildFlowTraceUrl,
  extractFlowId,
} from "@synap-core/external-connect-client";

export default function ConnectionsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { workspaceId } = useWorkspace();
  const [activeTab, setActiveTab] = useState(
    searchParams.get("tab") === "advanced-sources"
      ? "advanced-sources"
      : "integrations"
  );
  const [lastFlowId, setLastFlowId] = useState<string | null>(null);

  const capabilitiesQuery = trpc.capabilities.list.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const connectorsQuery = trpc.connectors.status.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const telegramQuery = trpc.channelGateway.telegramStatus.useQuery(undefined, {
    enabled: !!workspaceId,
    refetchInterval: 60_000,
  });

  const feedsQuery = trpc.feeds.listFeeds.useQuery(
    { workspaceId: workspaceId ?? undefined, limit: 25, offset: 0 },
    { enabled: !!workspaceId, refetchInterval: 60_000 }
  );

  const checkHealthMutation = trpc.capabilities.checkHealth.useMutation({
    onSuccess: (result) => {
      void capabilitiesQuery.refetch();
      if (result.isHealthy) {
        showSuccessNotification({ message: `${result.serviceId} is healthy` });
      } else {
        showErrorNotification({
          message: `${result.serviceId} is unreachable`,
        });
      }
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });

  const keysQuery = trpc.apiKeys.list.useQuery();
  const rotateMutation = trpc.apiKeys.rotate.useMutation({
    onSuccess: () => {
      void keysQuery.refetch();
      showSuccessNotification({ message: "Key rotated." });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });
  const revokeMutation = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      void keysQuery.refetch();
      showSuccessNotification({ message: "Key revoked." });
    },
    onError: (err) => showErrorNotification({ message: err.message }),
  });
  const connectMutation = trpc.apiKeys.connectIntegration.useMutation({
    onSuccess: () => {
      void keysQuery.refetch();
      showSuccessNotification({
        message: "Integration key minted and verified.",
      });
    },
    onError: (err) => {
      const flowId = extractFlowId(err.message);
      setLastFlowId(flowId);
      showErrorNotification({ message: err.message });
    },
  });

  const integrationRows = useMemo(() => {
    const activeKeys = (keysQuery.data ?? []).filter(
      (k) =>
        k.isActive &&
        typeof k.hubId === "string" &&
        k.hubId.startsWith("integration:")
    );
    const byIntegration = new Map<string, (typeof activeKeys)[number][]>();
    for (const key of activeKeys) {
      const integration = key.hubId!.replace("integration:", "");
      const list = byIntegration.get(integration) ?? [];
      list.push(key);
      byIntegration.set(integration, list);
    }
    return [...byIntegration.entries()].map(([integration, keys]) => {
      const latest = [...keys].sort(
        (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)
      )[0];
      return {
        integration,
        keyCount: keys.length,
        latestKey: latest,
      };
    });
  }, [keysQuery.data]);

  const services = capabilitiesQuery.data?.intelligenceServices ?? [];

  if (!workspaceId) {
    return (
      <div className="p-8">
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Select a workspace</Alert.Title>
            <Alert.Description>
              Telegram, feeds, and external agent status are scoped to the
              active workspace. Choose one in the sidebar.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 p-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <IconPlugConnected className="text-primary" size={24} />
          <Text className="text-2xl font-semibold tracking-tight text-foreground">
            External connections
          </Text>
        </div>
        <Text className="max-w-3xl text-small text-default-500">
          Single control surface for external integrations, credentials, and
          service health. Manage reconnect, rotate, revoke, and diagnostics in
          one place.
        </Text>
      </header>

      <Tabs.Root
        selectedKey={activeTab}
        onSelectionChange={(k) => {
          const next = String(k);
          setActiveTab(next);
          const nextParams = new URLSearchParams(searchParams);
          if (next === "advanced-sources") {
            nextParams.set("tab", "advanced-sources");
          } else {
            nextParams.delete("tab");
          }
          setSearchParams(nextParams, { replace: true });
        }}
      >
        <Tabs.ListContainer>
          <Tabs.List>
            <Tabs.Tab id="integrations">Connected integrations</Tabs.Tab>
            <Tabs.Tab id="advanced-sources">Advanced sources</Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs.Root>

      {activeTab === "integrations" && (
        <Card.Root className="border border-divider">
          <Card.Header>
            <Card.Title className="inline-flex items-center gap-2">
              <IconKey size={18} />
              Connected integrations
            </Card.Title>
            <Card.Description>
              Hub inbound keys by integration. Reconnect creates a verified key.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            {keysQuery.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner color="accent" />
              </div>
            ) : integrationRows.length === 0 ? (
              <Text className="text-default-500">
                No integration keys yet. Start a connection from an external app
                (Raycast, CLI, OpenClaw) to create one.
              </Text>
            ) : (
              <div className="overflow-x-auto rounded-medium border border-divider">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-divider bg-default-50/80">
                      <th className="px-3 py-2 font-medium">Integration</th>
                      <th className="px-3 py-2 font-medium">Active keys</th>
                      <th className="px-3 py-2 font-medium">Last used</th>
                      <th className="px-3 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {integrationRows.map((row) => (
                      <tr
                        key={row.integration}
                        className="border-b border-divider/60 odd:bg-default-50/20"
                      >
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-0.5">
                            <Text className="text-sm font-medium capitalize">
                              {row.integration}
                            </Text>
                            <Text className="text-xs text-default-500">
                              {row.latestKey.hubId}
                            </Text>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Chip size="sm" variant="soft" color="default">
                            {row.keyCount}
                          </Chip>
                        </td>
                        <td className="px-3 py-2 text-default-500">
                          {row.latestKey.lastUsedAt
                            ? new Date(
                                row.latestKey.lastUsedAt
                              ).toLocaleString()
                            : "Never"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onPress={() =>
                                navigate(
                                  `/connections/${encodeURIComponent(row.integration)}`
                                )
                              }
                            >
                              <span className="inline-flex items-center gap-1">
                                <IconExternalLink size={13} />
                                Details
                              </span>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={connectMutation.isPending}
                              onPress={() =>
                                connectMutation.mutate({
                                  integration: row.integration as
                                    | "raycast"
                                    | "cli"
                                    | "openclaw"
                                    | "custom",
                                  strategy: "replace_existing",
                                })
                              }
                            >
                              <span className="inline-flex items-center gap-1">
                                <IconRefresh size={13} />
                                Reconnect (override)
                              </span>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={rotateMutation.isPending}
                              onPress={() =>
                                rotateMutation.mutate({
                                  keyId: row.latestKey.id,
                                })
                              }
                            >
                              <span className="inline-flex items-center gap-1">
                                <IconRotate size={13} />
                                Rotate
                              </span>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={revokeMutation.isPending}
                              onPress={() =>
                                revokeMutation.mutate({
                                  keyId: row.latestKey.id,
                                })
                              }
                            >
                              <span className="inline-flex items-center gap-1">
                                <IconTrash size={13} />
                                Revoke latest
                              </span>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {lastFlowId && (
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onPress={() => {
                    window.location.href = buildFlowTraceUrl(lastFlowId);
                  }}
                >
                  Open latest failed flow trace
                </Button>
              </div>
            )}
          </Card.Content>
        </Card.Root>
      )}

      {activeTab === "advanced-sources" && (
        <>
          <Card.Root className="border border-divider">
            <Card.Header>
              <Card.Title className="inline-flex items-center gap-2">
                <IconShieldCheck size={18} />
                Trust & governance
              </Card.Title>
              <Card.Description>
                Pending trusted issuers and approval workflow.
              </Card.Description>
            </Card.Header>
            <Card.Content>
              <Button
                variant="outline"
                onPress={() => navigate("/trusted-issuers")}
              >
                Open trusted issuers
              </Button>
            </Card.Content>
          </Card.Root>
          <Card.Root className="border border-divider">
            <Card.Header>
              <Card.Title className="inline-flex items-center gap-2">
                <IconCloud size={18} />
                Runtime dependencies
              </Card.Title>
              <Card.Description>
                Core infrastructure checks and logs are managed in Pod Services.
              </Card.Description>
            </Card.Header>
            <Card.Content>
              <Button
                variant="outline"
                onPress={() => navigate("/pod-services")}
              >
                Open Pod Services
              </Button>
            </Card.Content>
          </Card.Root>

          <Card.Root className="border border-divider">
            <Card.Header>
              <Card.Title className="inline-flex items-center gap-2">
                <IconPlugConnected size={18} />
                Intelligence services
              </Card.Title>
              <Card.Description>
                Registry + last health check (
                <code className="text-xs">capabilities.list</code>)
              </Card.Description>
            </Card.Header>
            <Card.Content>
              {capabilitiesQuery.isLoading ? (
                <div className="flex justify-center py-8">
                  <Spinner color="accent" />
                </div>
              ) : (
                <div className="overflow-x-auto rounded-medium border border-divider">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-divider bg-default-50/80">
                        <th className="px-3 py-2 font-medium">Service</th>
                        <th className="px-3 py-2 font-medium">Health</th>
                        <th className="px-3 py-2 font-medium">Ping</th>
                      </tr>
                    </thead>
                    <tbody>
                      {services.map((svc) => (
                        <tr
                          key={svc.id}
                          className="border-b border-divider/60 odd:bg-default-50/20"
                        >
                          <td className="px-3 py-2">
                            <div className="flex flex-col gap-0.5">
                              <Text className="text-sm font-medium">
                                {svc.name}
                              </Text>
                              <Text className="text-xs text-default-500">
                                {svc.serviceId}
                              </Text>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <Chip size="sm" variant="soft" color="default">
                              {svc.lastHealthStatus ?? "unknown"}
                            </Chip>
                          </td>
                          <td className="px-3 py-2">
                            {svc.serviceId !== "default" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                isIconOnly
                                isDisabled={
                                  checkHealthMutation.isPending &&
                                  checkHealthMutation.variables?.serviceId ===
                                    svc.serviceId
                                }
                                onPress={() =>
                                  checkHealthMutation.mutate({
                                    serviceId: svc.serviceId,
                                  })
                                }
                                aria-label="Ping health"
                              >
                                {checkHealthMutation.isPending &&
                                checkHealthMutation.variables?.serviceId ===
                                  svc.serviceId ? (
                                  <Spinner size="sm" color="current" />
                                ) : (
                                  <IconRefresh size={16} />
                                )}
                              </Button>
                            ) : (
                              <Text className="text-xs text-default-400">
                                —
                              </Text>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card.Content>
          </Card.Root>

          <Card.Root className="border border-divider">
            <Card.Header>
              <Card.Title>OpenClaw runtime</Card.Title>
              <Card.Description>
                Instantiation, key lifecycle, diagnostics, and troubleshooting
                are now in the dedicated OpenClaw control center.
              </Card.Description>
            </Card.Header>
            <Card.Content>
              <Button variant="outline" onPress={() => navigate("/openclaw")}>
                Open OpenClaw control center
              </Button>
            </Card.Content>
          </Card.Root>

          <Card.Root className="border border-divider">
            <Card.Header>
              <Card.Title className="inline-flex items-center gap-2">
                <IconCloud size={18} />
                Control plane & connectors
              </Card.Title>
            </Card.Header>
            <Card.Content className="space-y-2 text-sm text-default-600">
              {connectorsQuery.isLoading ? (
                <Spinner size="sm" color="accent" />
              ) : (
                <>
                  <div>
                    <Text className="font-medium text-foreground">CP URL</Text>
                    <Text className="text-xs">
                      {connectorsQuery.data?.controlPlane.url ?? "—"}
                    </Text>
                  </div>
                  <div>
                    <Text className="font-medium text-foreground">Pod ID</Text>
                    <Text className="text-xs">
                      {connectorsQuery.data?.controlPlane.podId ?? "—"}
                    </Text>
                  </div>
                  <div>
                    <Text className="font-medium text-foreground">Tier</Text>
                    <Text className="text-xs">
                      {connectorsQuery.data?.controlPlane.tier ?? "—"}
                    </Text>
                  </div>
                </>
              )}
            </Card.Content>
          </Card.Root>

          <div
            className="grid gap-4"
            style={{
              gap: spacing[4],
              gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))",
            }}
          >
            <Card.Root className="border border-divider">
              <Card.Header>
                <Card.Title className="inline-flex items-center gap-2">
                  <IconBrandTelegram size={18} />
                  Telegram gateway
                </Card.Title>
                <Card.Description>
                  Workspace bot + webhook wiring
                </Card.Description>
              </Card.Header>
              <Card.Content className="space-y-2 text-sm">
                {telegramQuery.isLoading ? (
                  <Spinner size="sm" color="accent" />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip size="sm" variant="soft" color="default">
                        {telegramQuery.data?.configured
                          ? "Configured"
                          : "Not configured"}
                      </Chip>
                      {telegramQuery.data?.enabled ? (
                        <Chip size="sm" variant="soft" color="success">
                          Enabled
                        </Chip>
                      ) : (
                        <Chip size="sm" variant="soft" color="warning">
                          Disabled
                        </Chip>
                      )}
                    </div>
                    {telegramQuery.data?.message ? (
                      <Alert status="warning">
                        <Alert.Indicator />
                        <Alert.Content>
                          <Alert.Description>
                            {telegramQuery.data.message}
                          </Alert.Description>
                        </Alert.Content>
                      </Alert>
                    ) : null}
                    <Text className="text-xs text-default-500">
                      Bot: {telegramQuery.data?.botUsername ?? "—"} · Source:{" "}
                      {telegramQuery.data?.source ?? "—"}
                    </Text>
                  </>
                )}
              </Card.Content>
            </Card.Root>

            <Card.Root className="border border-divider">
              <Card.Header>
                <Card.Title className="inline-flex items-center gap-2">
                  <IconRss size={18} />
                  RSS & feeds (your channels)
                </Card.Title>
                <Card.Description>
                  Feed channels you own in this workspace (
                  <code className="text-xs">feeds.listFeeds</code>)
                </Card.Description>
              </Card.Header>
              <Card.Content>
                {feedsQuery.isLoading ? (
                  <Spinner size="sm" color="accent" />
                ) : (feedsQuery.data?.items?.length ?? 0) === 0 ? (
                  <Text className="text-sm text-default-500">
                    No active feed channels for this workspace.
                  </Text>
                ) : (
                  <ul className="space-y-2">
                    {feedsQuery.data!.items.map((f) => (
                      <li
                        key={f.id}
                        className="rounded-medium border border-divider px-3 py-2 text-sm"
                      >
                        <div className="font-medium">{f.title}</div>
                        <div className="text-xs text-default-500">
                          {f.feedType ?? "feed"} · last run:{" "}
                          {f.status.lastRunAt
                            ? new Date(f.status.lastRunAt).toLocaleString()
                            : "—"}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card.Content>
            </Card.Root>
          </div>
        </>
      )}
    </div>
  );
}

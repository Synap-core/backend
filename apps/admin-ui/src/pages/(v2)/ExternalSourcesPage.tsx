import { Alert, Card, Chip, Spinner, Text } from "@heroui/react";
import {
  IconBrandTelegram,
  IconCloud,
  IconExternalLink,
  IconPlugConnected,
  IconRss,
} from "@tabler/icons-react";
import { Button } from "@heroui/react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";
import { useNavigate } from "react-router-dom";

export default function ExternalSourcesPage() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();

  const connectorsQuery = trpc.connectors.status.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const capabilitiesQuery = trpc.capabilities.list.useQuery(undefined, {
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

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-6 md:p-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <IconPlugConnected className="text-primary" size={24} />
          <Text className="text-2xl font-semibold tracking-tight text-foreground">
            External sources (advanced)
          </Text>
        </div>
        <Text className="max-w-3xl text-small text-default-500">
          Advanced source diagnostics. Use the External Connections page for
          day-to-day connect/reconnect and key lifecycle operations.
        </Text>
      </header>

      {!workspaceId ? (
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
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card.Root className="border border-divider">
          <Card.Content className="space-y-1 p-4">
            <div className="inline-flex items-center gap-2 text-default-500">
              <IconCloud size={16} />
              <Text className="text-xs uppercase tracking-wider">
                Connectors
              </Text>
            </div>
            <Text className="text-sm text-default-600">
              {connectorsQuery.data?.controlPlane.url ?? "No control-plane URL"}
            </Text>
            <Text className="text-xs text-default-500">
              Tier: {connectorsQuery.data?.controlPlane.tier ?? "—"}
            </Text>
          </Card.Content>
        </Card.Root>
        <Card.Root className="border border-divider">
          <Card.Content className="space-y-1 p-4">
            <div className="inline-flex items-center gap-2 text-default-500">
              <IconRss size={16} />
              <Text className="text-xs uppercase tracking-wider">Feeds</Text>
            </div>
            <Text className="text-2xl font-semibold">
              {workspaceId ? (feedsQuery.data?.items?.length ?? 0) : "—"}
            </Text>
            <Text className="text-xs text-default-500">
              Active workspace feed channels
            </Text>
          </Card.Content>
        </Card.Root>
        <Card.Root className="border border-divider">
          <Card.Content className="space-y-2 p-4">
            <Text className="text-xs uppercase tracking-wider text-default-500">
              OpenClaw
            </Text>
            <Text className="text-sm text-default-600">
              Runtime lifecycle now lives in dedicated control center.
            </Text>
            <Button
              size="sm"
              variant="outline"
              onPress={() => navigate("/openclaw")}
            >
              <span className="inline-flex items-center gap-1">
                <IconExternalLink size={14} />
                Open control center
              </span>
            </Button>
          </Card.Content>
        </Card.Root>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card.Root className="border border-divider">
          <Card.Header>
            <Card.Title className="inline-flex items-center gap-2">
              <IconBrandTelegram size={18} />
              Telegram gateway
            </Card.Title>
            <Card.Description>Workspace bot + webhook wiring</Card.Description>
          </Card.Header>
          <Card.Content className="space-y-2 text-sm">
            {!workspaceId ? (
              <Text className="text-default-500">Select a workspace.</Text>
            ) : telegramQuery.isLoading ? (
              <Spinner size="sm" color="accent" />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip size="sm" variant="soft" color="default">
                    {telegramQuery.data?.configured
                      ? "Configured"
                      : "Not configured"}
                  </Chip>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={telegramQuery.data?.enabled ? "success" : "warning"}
                  >
                    {telegramQuery.data?.enabled ? "Enabled" : "Disabled"}
                  </Chip>
                </div>
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
              RSS feeds
            </Card.Title>
            <Card.Description>
              Feed channels for the active workspace.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            {!workspaceId ? (
              <Text className="text-default-500">Select a workspace.</Text>
            ) : feedsQuery.isLoading ? (
              <Spinner size="sm" color="accent" />
            ) : (feedsQuery.data?.items?.length ?? 0) === 0 ? (
              <Text className="text-sm text-default-500">
                No active feed channels for this workspace.
              </Text>
            ) : (
              <ul className="space-y-2">
                {feedsQuery.data!.items.map((feed) => (
                  <li
                    key={feed.id}
                    className="rounded-medium border border-divider px-3 py-2 text-sm"
                  >
                    <div className="font-medium">{feed.title}</div>
                    <div className="text-xs text-default-500">
                      {feed.feedType ?? "feed"} · last run:{" "}
                      {feed.status.lastRunAt
                        ? new Date(feed.status.lastRunAt).toLocaleString()
                        : "—"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card.Content>
        </Card.Root>
      </div>

      <Card.Root className="border border-divider">
        <Card.Header>
          <Card.Title>Intelligence registry</Card.Title>
          <Card.Description>
            Registered intelligence services available on this pod.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="flex flex-wrap gap-2">
            {(capabilitiesQuery.data?.intelligenceServices ?? []).map((svc) => (
              <Chip key={svc.id} size="sm" variant="soft" color="default">
                {svc.name}
              </Chip>
            ))}
          </div>
        </Card.Content>
      </Card.Root>
    </div>
  );
}

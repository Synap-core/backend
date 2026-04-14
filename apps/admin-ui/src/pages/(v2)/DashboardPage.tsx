import { useState, useMemo } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { Button } from "@heroui/react";
import { Card } from "@heroui/react";
import { Chip } from "@heroui/react";
import {
  IconActivity,
  IconBolt,
  IconUsers,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconBuildingCommunity,
  IconFiles,
  IconRobot,
  IconDatabase,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import {
  MetricCardSkeleton,
  EventListItemSkeleton,
} from "../../components/loading/LoadingSkeletons";
import VirtualizedEventList from "../../components/events/VirtualizedEventList";
import { showInfoNotification } from "../../lib/notifications";
import SearchCommandButton from "../../components/layout/SearchCommandButton";

export default function DashboardPage() {
  const navigate = useNavigate();
  const { openCommandPalette } = useOutletContext<{
    openCommandPalette: () => void;
  }>();
  const [isAutoRefreshEnabled, setIsAutoRefreshEnabled] = useState(true);

  const { data: podStats, isLoading: isLoadingPodStats } =
    trpc.system.getDataPodStats.useQuery(undefined, {
      refetchInterval: isAutoRefreshEnabled ? 30000 : false,
    });

  const {
    data: metrics,
    refetch: refetchMetrics,
    isLoading: isLoadingMetrics,
    dataUpdatedAt: metricsUpdatedAt,
  } = trpc.system.getDashboardMetrics.useQuery(undefined, {
    refetchInterval: isAutoRefreshEnabled ? 5000 : false,
    refetchOnWindowFocus: true,
  });

  const {
    data: recentEventsData,
    refetch: refetchEvents,
    isLoading: isLoadingEvents,
  } = trpc.system.getRecentEvents.useQuery(
    { limit: 10 },
    {
      refetchInterval: isAutoRefreshEnabled ? 5000 : false,
      refetchOnWindowFocus: true,
    }
  );

  const events = recentEventsData?.events;

  const lastRefresh = useMemo(
    () => (metricsUpdatedAt ? new Date(metricsUpdatedAt) : new Date()),
    [metricsUpdatedAt]
  );

  const handleManualRefresh = () => {
    refetchMetrics();
    refetchEvents();
    showInfoNotification({
      message: "Refreshing dashboard data...",
      title: "Refresh",
    });
  };

  const healthStatus = metrics?.health.status ?? "healthy";
  const healthColor =
    healthStatus === "healthy"
      ? "success"
      : healthStatus === "degraded"
        ? "warning"
        : "danger";

  return (
    <div className="w-full max-w-[1400px] p-8">
      <div className="flex flex-col gap-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Your data pod
          </h1>
          <p className="max-w-2xl text-small text-default-500">
            A calm home for this server — health, activity, and quick paths into
            operations. Workspace editing stays in Synap Browser.
          </p>
        </header>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
          {isLoadingPodStats ? (
            <>
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
            </>
          ) : (
            <>
              <Card.Root
                className="cursor-pointer border border-divider transition-colors hover:bg-default-100"
                onClick={() => navigate("/users")}
              >
                <Card.Header className="flex flex-row items-start justify-between pb-1">
                  <span className="text-small font-medium text-default-500">
                    Users
                  </span>
                  <IconUsers size={20} className="text-primary" />
                </Card.Header>
                <Card.Content className="gap-1">
                  <p className="text-3xl font-bold text-foreground">
                    {(podStats?.userCount ?? 0) + (podStats?.agentCount ?? 0)}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Chip size="sm" variant="soft" color="accent">
                      {podStats?.userCount ?? 0} human
                    </Chip>
                    <Chip size="sm" variant="soft" color="warning">
                      {podStats?.agentCount ?? 0} agent
                    </Chip>
                  </div>
                </Card.Content>
              </Card.Root>

              <Card.Root
                className="cursor-pointer border border-divider transition-colors hover:bg-default-100"
                onClick={() => navigate("/workspaces")}
              >
                <Card.Header className="flex flex-row items-start justify-between pb-1">
                  <span className="text-small font-medium text-default-500">
                    Workspaces
                  </span>
                  <IconBuildingCommunity size={20} className="text-secondary" />
                </Card.Header>
                <Card.Content>
                  <p className="text-3xl font-bold text-foreground">
                    {podStats?.workspaceCount ?? 0}
                  </p>
                  <p className="mt-1 text-xs text-default-400">
                    Across this pod
                  </p>
                </Card.Content>
              </Card.Root>

              <Card.Root className="border border-divider">
                <Card.Header className="flex flex-row items-start justify-between pb-1">
                  <span className="text-small font-medium text-default-500">
                    Entities
                  </span>
                  <IconDatabase size={20} className="text-success" />
                </Card.Header>
                <Card.Content>
                  <p className="text-3xl font-bold text-foreground">
                    {podStats?.entityCount ?? 0}
                  </p>
                  <p className="mt-1 text-xs text-default-400">
                    People, companies, projects…
                  </p>
                </Card.Content>
              </Card.Root>

              <Card.Root className="border border-divider">
                <Card.Header className="flex flex-row items-start justify-between pb-1">
                  <span className="text-small font-medium text-default-500">
                    Documents
                  </span>
                  <IconFiles size={20} className="text-warning" />
                </Card.Header>
                <Card.Content>
                  <p className="text-3xl font-bold text-foreground">
                    {podStats?.documentCount ?? 0}
                  </p>
                  <p className="mt-1 text-xs text-default-400">
                    Notes, files, pages
                  </p>
                </Card.Content>
              </Card.Root>
            </>
          )}
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-4">
          {isLoadingMetrics ? (
            <>
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
            </>
          ) : (
            <>
              <Card.Root className="border border-divider">
                <Card.Content className="flex items-center justify-between gap-3 py-4">
                  <div>
                    <p className="text-xs text-default-400">System health</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Chip size="sm" variant="soft" color={healthColor}>
                        {healthStatus === "healthy"
                          ? "Healthy"
                          : healthStatus === "degraded"
                            ? "Degraded"
                            : "Critical"}
                      </Chip>
                      <span className="text-xs text-default-400">
                        {metrics?.health.errorRate.toFixed(1) ?? "0.0"}% errors
                      </span>
                    </div>
                  </div>
                  <IconActivity size={22} className="text-default-400" />
                </Card.Content>
              </Card.Root>

              <Card.Root className="border border-divider">
                <Card.Content className="flex items-center justify-between gap-3 py-4">
                  <div>
                    <p className="text-xs text-default-400">Throughput</p>
                    <p className="mt-1 text-xl font-bold text-foreground">
                      {metrics?.throughput.eventsPerSecond.toFixed(2) ?? "0.00"}
                      <span className="ml-1 text-xs font-normal text-default-400">
                        events/sec
                      </span>
                    </p>
                  </div>
                  <IconBolt size={22} className="text-primary" />
                </Card.Content>
              </Card.Root>

              <Card.Root className="border border-divider">
                <Card.Content className="flex items-center justify-between gap-3 py-4">
                  <div>
                    <p className="text-xs text-default-400">Live connections</p>
                    <p className="mt-1 text-xl font-bold text-foreground">
                      {metrics?.connections.activeSSEClients ?? 0}
                      <span className="ml-1 text-xs font-normal text-default-400">
                        SSE clients
                      </span>
                    </p>
                  </div>
                  <IconRobot size={22} className="text-secondary" />
                </Card.Content>
              </Card.Root>
            </>
          )}
        </div>

        <Card.Root className="border border-divider">
          <Card.Header>
            <Card.Title>Quick actions</Card.Title>
            <Card.Description>
              Search people and events, or open API keys
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
              <SearchCommandButton onPress={openCommandPalette} />
              <Button variant="outline" onPress={() => navigate("/users")}>
                <span className="inline-flex items-center gap-2">
                  <IconUsers size={18} />
                  Users
                </span>
              </Button>
              <Button variant="primary" onPress={() => navigate("/api-keys")}>
                API keys
              </Button>
            </div>
          </Card.Content>
        </Card.Root>

        <Card.Root className="border border-divider">
          <Card.Header className="flex flex-row flex-wrap items-center justify-between gap-3">
            <div>
              <Card.Title>Recent activity</Card.Title>
              <Card.Description>
                Last refresh {lastRefresh.toLocaleTimeString()}
              </Card.Description>
            </div>
            <div className="flex items-center gap-1">
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="Refresh now"
                onPress={handleManualRefresh}
              >
                <IconRefresh size={18} />
              </Button>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={
                  isAutoRefreshEnabled
                    ? "Pause auto-refresh"
                    : "Resume auto-refresh"
                }
                onPress={() => setIsAutoRefreshEnabled(!isAutoRefreshEnabled)}
              >
                {isAutoRefreshEnabled ? (
                  <IconPlayerPause size={18} />
                ) : (
                  <IconPlayerPlay size={18} />
                )}
              </Button>
            </div>
          </Card.Header>
          <Card.Content>
            {isLoadingEvents ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <EventListItemSkeleton key={i} />
                ))}
              </div>
            ) : !events || events.length === 0 ? (
              <p className="py-10 text-center text-small text-default-400">
                No recent events
              </p>
            ) : (
              <VirtualizedEventList
                events={events.map((e) => ({
                  ...e,
                  eventId: e.id,
                  eventType: e.type,
                }))}
                onEventClick={(eventId) =>
                  navigate(`/events?eventId=${encodeURIComponent(eventId)}`)
                }
              />
            )}

            {events && events.length > 0 ? (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => navigate("/events")}
                >
                  View all events
                </Button>
              </div>
            ) : null}
          </Card.Content>
        </Card.Root>
      </div>
    </div>
  );
}

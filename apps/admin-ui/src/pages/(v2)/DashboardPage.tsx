import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Title,
  Text,
  Stack,
  Card,
  Group,
  Button,
  ActionIcon,
  Badge,
} from "@mantine/core";
import SearchModal from "../../components/search/SearchModal";
import {
  IconActivity,
  IconBolt,
  IconUsers,
  IconSearch,
  IconTimeline,
  IconFlask,
  IconMap,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconFolder,
  IconBuildingCommunity,
  IconFiles,
  IconRobot,
  IconDatabase,
} from "@tabler/icons-react";
import { colors, typography, spacing, borderRadius } from "../../theme/tokens";
import { trpc } from "../../lib/trpc";
import {
  MetricCardSkeleton,
  EventListItemSkeleton,
} from "../../components/loading/LoadingSkeletons";
import VirtualizedEventList from "../../components/events/VirtualizedEventList";
import { showInfoNotification } from "../../lib/notifications";

export default function DashboardPage() {
  const navigate = useNavigate();
  const [isAutoRefreshEnabled, setIsAutoRefreshEnabled] = useState(true);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchType, setSearchType] = useState<"user" | "event">("user");

  // Fetch pod stats
  const { data: podStats, isLoading: isLoadingPodStats } =
    trpc.system.getDataPodStats.useQuery(undefined, {
      refetchInterval: isAutoRefreshEnabled ? 30000 : false,
    });

  // Fetch dashboard metrics
  const {
    data: metrics,
    refetch: refetchMetrics,
    isLoading: isLoadingMetrics,
    dataUpdatedAt: metricsUpdatedAt,
  } = trpc.system.getDashboardMetrics.useQuery(undefined, {
    refetchInterval: isAutoRefreshEnabled ? 5000 : false,
    refetchOnWindowFocus: true,
  });

  // Fetch recent events
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

  // Health status configuration
  const healthConfig = {
    healthy: {
      label: "Healthy",
      color: colors.health.healthy,
      bgColor: "#D1FAE5",
    },
    degraded: {
      label: "Degraded",
      color: colors.health.degraded,
      bgColor: "#FEF3C7",
    },
    critical: {
      label: "Critical",
      color: colors.health.critical,
      bgColor: "#FEE2E2",
    },
  };

  const healthStatus = metrics?.health.status || "healthy";
  const healthStyle = healthConfig[healthStatus];

  return (
    <div style={{ width: "100%", padding: spacing[8] }}>
      <Stack gap={spacing[8]}>
        {/* Header */}
        <div>
          <Title
            order={1}
            style={{
              fontFamily: typography.fontFamily.sans,
              color: colors.text.primary,
            }}
          >
            Data Pod
          </Title>
          <Text
            size="sm"
            style={{
              color: colors.text.secondary,
              fontFamily: typography.fontFamily.sans,
            }}
          >
            Overview of your self-hosted Synap instance
          </Text>
        </div>

        {/* Row 1 — Key Counts */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: spacing[4],
          }}
        >
          {isLoadingPodStats ? (
            <>
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
            </>
          ) : (
            <>
              {/* Users Card */}
              <Card
                padding={spacing[4]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                  cursor: "pointer",
                }}
                onClick={() => navigate("/users")}
              >
                <Group justify="space-between" mb={spacing[2]}>
                  <Text
                    size="sm"
                    fw={typography.fontWeight.medium}
                    c={colors.text.secondary}
                  >
                    Users
                  </Text>
                  <IconUsers size={20} color={colors.semantic.info} />
                </Group>
                <Text
                  size="2rem"
                  fw={typography.fontWeight.bold}
                  c={colors.text.primary}
                >
                  {(podStats?.userCount ?? 0) + (podStats?.agentCount ?? 0)}
                </Text>
                <Group gap={spacing[2]} mt={spacing[1]}>
                  <Badge size="xs" variant="light" color="blue">
                    {podStats?.userCount ?? 0} human
                  </Badge>
                  <Badge size="xs" variant="light" color="orange">
                    {podStats?.agentCount ?? 0} agent
                  </Badge>
                </Group>
              </Card>

              {/* Workspaces Card */}
              <Card
                padding={spacing[4]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Group justify="space-between" mb={spacing[2]}>
                  <Text
                    size="sm"
                    fw={typography.fontWeight.medium}
                    c={colors.text.secondary}
                  >
                    Workspaces
                  </Text>
                  <IconBuildingCommunity
                    size={20}
                    color={colors.eventTypes.created}
                  />
                </Group>
                <Text
                  size="2rem"
                  fw={typography.fontWeight.bold}
                  c={colors.text.primary}
                >
                  {podStats?.workspaceCount ?? 0}
                </Text>
                <Text size="xs" c={colors.text.tertiary} mt={spacing[1]}>
                  across the pod
                </Text>
              </Card>

              {/* Entities Card */}
              <Card
                padding={spacing[4]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Group justify="space-between" mb={spacing[2]}>
                  <Text
                    size="sm"
                    fw={typography.fontWeight.medium}
                    c={colors.text.secondary}
                  >
                    Entities
                  </Text>
                  <IconDatabase size={20} color={colors.semantic.success} />
                </Group>
                <Text
                  size="2rem"
                  fw={typography.fontWeight.bold}
                  c={colors.text.primary}
                >
                  {podStats?.entityCount ?? 0}
                </Text>
                <Text size="xs" c={colors.text.tertiary} mt={spacing[1]}>
                  people, companies, projects...
                </Text>
              </Card>

              {/* Documents Card */}
              <Card
                padding={spacing[4]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Group justify="space-between" mb={spacing[2]}>
                  <Text
                    size="sm"
                    fw={typography.fontWeight.medium}
                    c={colors.text.secondary}
                  >
                    Documents
                  </Text>
                  <IconFiles size={20} color={colors.semantic.warning} />
                </Group>
                <Text
                  size="2rem"
                  fw={typography.fontWeight.bold}
                  c={colors.text.primary}
                >
                  {podStats?.documentCount ?? 0}
                </Text>
                <Text size="xs" c={colors.text.tertiary} mt={spacing[1]}>
                  notes, docs, pages
                </Text>
              </Card>
            </>
          )}
        </div>

        {/* Row 2 — System Health (compact) */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
            gap: spacing[4],
          }}
        >
          {isLoadingMetrics ? (
            <>
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
            </>
          ) : (
            <>
              {/* Health Status */}
              <Card
                padding={spacing[3]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Group justify="space-between">
                  <div>
                    <Text size="xs" c={colors.text.tertiary} mb={2}>
                      System Health
                    </Text>
                    <Group gap={spacing[2]}>
                      <Badge
                        size="lg"
                        variant="light"
                        color={
                          healthStatus === "healthy"
                            ? "green"
                            : healthStatus === "degraded"
                              ? "yellow"
                              : "red"
                        }
                      >
                        {healthStyle.label}
                      </Badge>
                      <Text size="xs" c={colors.text.tertiary}>
                        {metrics?.health.errorRate.toFixed(1) || "0.0"}% errors
                      </Text>
                    </Group>
                  </div>
                  <IconActivity size={20} color={healthStyle.color} />
                </Group>
              </Card>

              {/* Throughput */}
              <Card
                padding={spacing[3]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Group justify="space-between">
                  <div>
                    <Text size="xs" c={colors.text.tertiary} mb={2}>
                      Throughput
                    </Text>
                    <Group gap={spacing[2]} align="baseline">
                      <Text
                        size="xl"
                        fw={typography.fontWeight.bold}
                        c={colors.text.primary}
                      >
                        {metrics?.throughput.eventsPerSecond.toFixed(2) ||
                          "0.00"}
                      </Text>
                      <Text size="xs" c={colors.text.tertiary}>
                        events/sec
                      </Text>
                    </Group>
                  </div>
                  <IconBolt size={20} color={colors.semantic.info} />
                </Group>
              </Card>

              {/* Connections */}
              <Card
                padding={spacing[3]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Group justify="space-between">
                  <div>
                    <Text size="xs" c={colors.text.tertiary} mb={2}>
                      Live Connections
                    </Text>
                    <Group gap={spacing[2]} align="baseline">
                      <Text
                        size="xl"
                        fw={typography.fontWeight.bold}
                        c={colors.text.primary}
                      >
                        {metrics?.connections.activeSSEClients ?? 0}
                      </Text>
                      <Text size="xs" c={colors.text.tertiary}>
                        SSE clients
                      </Text>
                    </Group>
                  </div>
                  <IconRobot size={20} color={colors.eventTypes.ai} />
                </Group>
              </Card>
            </>
          )}
        </div>

        {/* Row 3 — Quick Actions */}
        <Card
          padding={spacing[4]}
          radius={borderRadius.lg}
          style={{
            border: `1px solid ${colors.border.default}`,
            backgroundColor: colors.background.primary,
          }}
        >
          <Text
            size="lg"
            fw={typography.fontWeight.semibold}
            mb={spacing[4]}
            c={colors.text.primary}
          >
            Quick Actions
          </Text>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: spacing[3],
            }}
          >
            <Button
              variant="light"
              leftSection={<IconSearch size={18} />}
              onClick={() => {
                setSearchType("user");
                setSearchModalOpen(true);
              }}
            >
              Investigate User
            </Button>
            <Button
              variant="light"
              leftSection={<IconTimeline size={18} />}
              onClick={() => {
                setSearchType("event");
                setSearchModalOpen(true);
              }}
            >
              View Event Trace
            </Button>
            <Button
              variant="light"
              leftSection={<IconFlask size={18} />}
              onClick={() => navigate("/testing")}
            >
              Test AI Tool
            </Button>
            <Button
              variant="light"
              leftSection={<IconUsers size={18} />}
              onClick={() => navigate("/users")}
            >
              Manage Users
            </Button>
            <Button
              variant="light"
              leftSection={<IconFolder size={18} />}
              onClick={() => navigate("/files")}
            >
              Browse Files
            </Button>
            <Button
              variant="light"
              leftSection={<IconMap size={18} />}
              onClick={() => navigate("/flow")}
            >
              View Architecture
            </Button>
          </div>
        </Card>

        {/* Row 4 — Live Event Stream */}
        <Card
          padding={spacing[4]}
          radius={borderRadius.lg}
          style={{
            border: `1px solid ${colors.border.default}`,
            backgroundColor: colors.background.primary,
          }}
        >
          <Group justify="space-between" mb={spacing[4]}>
            <Text
              size="lg"
              fw={typography.fontWeight.semibold}
              c={colors.text.primary}
            >
              Recent Activity
            </Text>
            <Group gap={spacing[2]}>
              <Text size="xs" c={colors.text.tertiary}>
                Last refresh: {lastRefresh.toLocaleTimeString()}
              </Text>
              <ActionIcon
                variant="subtle"
                onClick={handleManualRefresh}
                title="Refresh now"
              >
                <IconRefresh size={18} />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                onClick={() => setIsAutoRefreshEnabled(!isAutoRefreshEnabled)}
                title={
                  isAutoRefreshEnabled
                    ? "Pause auto-refresh"
                    : "Resume auto-refresh"
                }
              >
                {isAutoRefreshEnabled ? (
                  <IconPlayerPause size={18} />
                ) : (
                  <IconPlayerPlay size={18} />
                )}
              </ActionIcon>
            </Group>
          </Group>

          {isLoadingEvents ? (
            <Stack gap={spacing[2]}>
              {Array.from({ length: 5 }).map((_, i) => (
                <EventListItemSkeleton key={i} />
              ))}
            </Stack>
          ) : !events || events.length === 0 ? (
            <Text size="sm" c={colors.text.tertiary} ta="center" p={spacing[6]}>
              No recent events
            </Text>
          ) : (
            <VirtualizedEventList
              events={events.map((e) => ({
                ...e,
                eventId: e.id,
                eventType: e.type,
              }))}
              onEventClick={(eventId) =>
                navigate(`/investigate?eventId=${encodeURIComponent(eventId)}`)
              }
              onPublishSimilar={(event) => {
                const eventData = JSON.stringify(event.data || {}, null, 2);
                navigate(
                  `/publish?type=${encodeURIComponent(event.eventType)}&data=${encodeURIComponent(eventData)}&userId=${encodeURIComponent(event.userId || "")}`
                );
              }}
            />
          )}

          {events && events.length > 0 && (
            <Group justify="center" mt={spacing[4]}>
              <Button
                variant="subtle"
                onClick={() => navigate("/events")}
                size="sm"
              >
                View all events
              </Button>
            </Group>
          )}
        </Card>
      </Stack>

      <SearchModal
        opened={searchModalOpen}
        onClose={() => setSearchModalOpen(false)}
        onSearch={(value) => {
          if (searchType === "user") {
            navigate(`/investigate?userId=${encodeURIComponent(value)}`);
          } else {
            navigate(`/investigate?eventId=${encodeURIComponent(value)}`);
          }
        }}
        title={searchType === "user" ? "Search User" : "Search Event"}
        placeholder={
          searchType === "user"
            ? "Enter user ID or email..."
            : "Enter event ID..."
        }
        label={searchType === "user" ? "User ID or Email" : "Event ID"}
        type={searchType}
      />
    </div>
  );
}

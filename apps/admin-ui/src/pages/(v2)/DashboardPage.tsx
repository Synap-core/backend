import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Title,
  Text,
  Stack,
  Card,
  Group,
  Button,
  ActionIcon,
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
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchType, setSearchType] = useState<"user" | "event">("user");

  // Fetch dashboard metrics
  const {
    data: metrics,
    refetch: refetchMetrics,
    isLoading: isLoadingMetrics,
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

  // Update last refresh timestamp
  useEffect(() => {
    if (metrics) {
      setLastRefresh(new Date());
    }
  }, [metrics]);

  const handleManualRefresh = () => {
    refetchMetrics();
    refetchEvents();
    setLastRefresh(new Date());
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
            Dashboard
          </Title>
          <Text
            size="sm"
            style={{
              color: colors.text.secondary,
              fontFamily: typography.fontFamily.sans,
            }}
          >
            Health Monitoring & Quick Access
          </Text>
        </div>

        {/* Metric Cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
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
              {/* Health Status Card */}
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
                    System Health
                  </Text>
                  <IconActivity size={20} color={healthStyle.color} />
                </Group>
                <div>
                  <Text
                    size="2rem"
                    fw={typography.fontWeight.bold}
                    style={{ color: healthStyle.color }}
                  >
                    {healthStyle.label}
                  </Text>
                  <Text size="xs" c={colors.text.tertiary} mt={spacing[1]}>
                    Error rate: {metrics?.health.errorRate.toFixed(1) || "0.0"}%
                  </Text>
                </div>
              </Card>

              {/* Events/s Card */}
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
                    Throughput
                  </Text>
                  <IconBolt size={20} color={colors.semantic.info} />
                </Group>
                <div>
                  <Text
                    size="2rem"
                    fw={typography.fontWeight.bold}
                    c={colors.text.primary}
                  >
                    {metrics?.throughput.eventsPerSecond.toFixed(2) || "0.00"}
                  </Text>
                  <Text size="xs" c={colors.text.tertiary} mt={spacing[1]}>
                    events/sec (last 5 min)
                  </Text>
                </div>
              </Card>

              {/* Total Events Card */}
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
                    Recent Activity
                  </Text>
                  <IconUsers size={20} color={colors.semantic.success} />
                </Group>
                <div>
                  <Text
                    size="2rem"
                    fw={typography.fontWeight.bold}
                    c={colors.text.primary}
                  >
                    {metrics?.throughput.totalEventsLast5Min || 0}
                  </Text>
                  <Text size="xs" c={colors.text.tertiary} mt={spacing[1]}>
                    events in last 5 min
                  </Text>
                </div>
              </Card>
            </>
          )}
        </div>

        {/* Quick Actions */}
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
              aria-label="Investigate user events"
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
              aria-label="View event trace"
            >
              View Event Trace
            </Button>
            <Button
              variant="light"
              leftSection={<IconFlask size={18} />}
              onClick={() => navigate("/testing")}
              aria-label="Test AI tools"
            >
              Test AI Tool
            </Button>
            <Button
              variant="light"
              leftSection={<IconMap size={18} />}
              onClick={() => navigate("/flow")}
              aria-label="View system architecture"
            >
              View Architecture
            </Button>
            <Button
              variant="light"
              leftSection={<IconFolder size={18} />}
              onClick={() => navigate("/files")}
              aria-label="Browse files"
            >
              Browse Files
            </Button>
          </div>
        </Card>

        {/* Live Event Stream */}
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
              Live Event Stream
            </Text>
            <Group gap={spacing[2]}>
              <Text size="xs" c={colors.text.tertiary}>
                Last refresh: {lastRefresh.toLocaleTimeString()}
              </Text>
              <ActionIcon
                variant="subtle"
                onClick={handleManualRefresh}
                title="Refresh now"
                aria-label="Refresh event stream"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleManualRefresh();
                  }
                }}
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
                aria-label={
                  isAutoRefreshEnabled
                    ? "Pause auto-refresh"
                    : "Resume auto-refresh"
                }
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setIsAutoRefreshEnabled(!isAutoRefreshEnabled);
                  }
                }}
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
                // Navigate to event publisher with pre-filled data
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
                onClick={() => navigate("/investigate")}
                size="sm"
              >
                View all events →
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

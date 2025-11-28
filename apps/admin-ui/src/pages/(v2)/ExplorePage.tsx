import { useState, memo } from 'react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Title,
  Text,
  Stack,
  Card,
  Group,
  Badge,
  Button,
  SimpleGrid,
  Accordion,
  Code,
  ScrollArea,
  Tabs,
} from '@mantine/core';
import {
  IconSearch,
  IconFlask,
  IconTimeline,
  IconArrowRight,
  IconDatabase,
  IconServer,
  IconBrandOpenai,
  IconPlugConnected,
  IconActivity,
  IconCode,
  IconPackage,
} from '@tabler/icons-react';
import { colors, typography, spacing, borderRadius } from '../../theme/tokens';
import { trpc } from '../../lib/trpc';
import { ArchitectureComponentSkeleton, ToolAccordionSkeleton, EventCardSkeleton } from '../../components/loading/LoadingSkeletons';

export default function ExplorePage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<string | null>('architecture');

  // Fetch capabilities for architecture view
  const { data: capabilities, isLoading: isLoadingCapabilities } = trpc.system.getCapabilities.useQuery();

  // Fetch dashboard metrics for statistics
  const { data: metrics, isLoading: isLoadingMetrics } = trpc.system.getDashboardMetrics.useQuery(undefined, {
    refetchInterval: 5000,
  });

  // Fetch recent events for examples
  const { data: recentEventsData, isLoading: isLoadingEvents } = trpc.system.getRecentEvents.useQuery({ limit: 5 });
  const recentEvents = recentEventsData?.events;

  const architectureComponents = [
    {
      name: 'Event Store',
      icon: IconDatabase,
      color: colors.eventTypes.system,
      description: 'PostgreSQL-based event sourcing store with full audit trail',
      stats: [
        { label: 'Total Events', value: metrics?.throughput.totalEventsLast5Min || 0 },
        { label: 'Error Rate', value: `${metrics?.health.errorRate.toFixed(1) || 0}%` },
      ],
    },
    {
      name: 'API Layer',
      icon: IconServer,
      color: colors.semantic.info,
      description: 'tRPC-based API with type-safe endpoints',
      stats: [
        { label: 'Active Routers', value: 6 },
        { label: 'Endpoints', value: capabilities?.tools.length || 0 },
      ],
    },
    {
      name: 'AI Engine',
      icon: IconBrandOpenai,
      color: colors.eventTypes.ai,
      description: 'Claude-powered AI with dynamic tool registry',
      stats: [
        { label: 'Available Tools', value: capabilities?.tools.length || 0 },
        { label: 'Conversations', value: '∞' },
      ],
    },
    {
      name: 'Real-time Sync',
      icon: IconPlugConnected,
      color: colors.semantic.success,
      description: 'Event broadcasting and real-time updates',
      stats: [
        { label: 'Events/sec', value: metrics?.throughput.eventsPerSecond.toFixed(2) || '0.00' },
        { label: 'Status', value: metrics?.health.status || 'unknown' },
      ],
    },
  ];

  return (
    <div style={{ width: '100%', padding: spacing[8] }}>
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
            Explore
          </Title>
          <Text
            size="sm"
            style={{
              color: colors.text.secondary,
              fontFamily: typography.fontFamily.sans,
            }}
          >
            System Exploration & Architecture
          </Text>
        </div>

        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="architecture" leftSection={<IconPackage size={16} />}>
              Architecture
            </Tabs.Tab>
            <Tabs.Tab value="statistics" leftSection={<IconActivity size={16} />}>
              Statistics
            </Tabs.Tab>
            <Tabs.Tab value="examples" leftSection={<IconCode size={16} />}>
              Live Examples
            </Tabs.Tab>
          </Tabs.List>

          {/* Architecture Tab */}
          <Tabs.Panel value="architecture" pt={spacing[4]}>
            <Stack gap={spacing[4]}>
              <Card
                padding={spacing[4]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Text size="lg" fw={typography.fontWeight.semibold} mb={spacing[4]}>
                  System Components
                </Text>
                <SimpleGrid cols={2} spacing={spacing[4]}>
                  {isLoadingCapabilities || isLoadingMetrics ? (
                    <>
                      <ArchitectureComponentSkeleton />
                      <ArchitectureComponentSkeleton />
                      <ArchitectureComponentSkeleton />
                      <ArchitectureComponentSkeleton />
                    </>
                  ) : (
                    architectureComponents.map((component) => {
                    const Icon = component.icon;
                    return (
                      <Card
                        key={component.name}
                        padding={spacing[4]}
                        style={{
                          backgroundColor: colors.background.secondary,
                          border: `1px solid ${colors.border.light}`,
                        }}
                      >
                        <Group mb={spacing[3]}>
                          <Icon size={24} color={component.color} />
                          <Text size="md" fw={typography.fontWeight.semibold}>
                            {component.name}
                          </Text>
                        </Group>
                        <Text size="sm" c={colors.text.secondary} mb={spacing[3]}>
                          {component.description}
                        </Text>
                        <Group gap={spacing[4]} mt={spacing[3]}>
                          {component.stats.map((stat) => (
                            <div key={stat.label}>
                              <Text size="xs" c={colors.text.tertiary}>
                                {stat.label}
                              </Text>
                              <Text size="lg" fw={typography.fontWeight.bold}>
                                {stat.value}
                              </Text>
                            </div>
                          ))}
                        </Group>
                      </Card>
                    );
                  })
                  )}
                </SimpleGrid>
              </Card>

              {/* Data Flow */}
              <Card
                padding={spacing[4]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Text size="lg" fw={typography.fontWeight.semibold} mb={spacing[4]}>
                  Event Flow Architecture
                </Text>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-around',
                    padding: spacing[6],
                    backgroundColor: colors.background.secondary,
                    borderRadius: borderRadius.base,
                  }}
                >
                  <FlowStep icon={IconServer} label="API Request" color={colors.semantic.info} />
                  <IconArrowRight size={32} color={colors.text.tertiary} />
                  <FlowStep
                    icon={IconBrandOpenai}
                    label="AI Processing"
                    color={colors.eventTypes.ai}
                  />
                  <IconArrowRight size={32} color={colors.text.tertiary} />
                  <FlowStep
                    icon={IconDatabase}
                    label="Event Store"
                    color={colors.eventTypes.system}
                  />
                  <IconArrowRight size={32} color={colors.text.tertiary} />
                  <FlowStep
                    icon={IconPlugConnected}
                    label="Real-time Sync"
                    color={colors.semantic.success}
                  />
                </div>
              </Card>
            </Stack>
          </Tabs.Panel>

          {/* Statistics Tab */}
          <Tabs.Panel value="statistics" pt={spacing[4]}>
            <SimpleGrid cols={2} spacing={spacing[4]}>
              {/* System Health */}
              <Card
                padding={spacing[4]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Text size="lg" fw={typography.fontWeight.semibold} mb={spacing[4]}>
                  System Health
                </Text>
                <Stack gap={spacing[3]}>
                  <StatRow
                    label="Status"
                    value={metrics?.health.status || 'unknown'}
                    color={
                      metrics?.health.status === 'healthy'
                        ? colors.health.healthy
                        : metrics?.health.status === 'degraded'
                          ? colors.health.degraded
                          : colors.health.critical
                    }
                  />
                  <StatRow
                    label="Error Rate"
                    value={`${metrics?.health.errorRate.toFixed(1) || 0}%`}
                  />
                  <StatRow
                    label="Events/sec"
                    value={metrics?.throughput.eventsPerSecond.toFixed(2) || '0.00'}
                  />
                  <StatRow
                    label="Total Events (5min)"
                    value={metrics?.throughput.totalEventsLast5Min || 0}
                  />
                </Stack>
              </Card>

              {/* Available Tools */}
              <Card
                padding={spacing[4]}
                radius={borderRadius.lg}
                style={{
                  border: `1px solid ${colors.border.default}`,
                  backgroundColor: colors.background.primary,
                }}
              >
                <Text size="lg" fw={typography.fontWeight.semibold} mb={spacing[4]}>
                  AI Tools Registry
                </Text>
                <ScrollArea style={{ height: '200px' }}>
                  {isLoadingCapabilities ? (
                    <ToolAccordionSkeleton />
                  ) : (
                    <Accordion>
                      {capabilities?.tools.map((tool) => (
                      <Accordion.Item key={tool.name} value={tool.name}>
                        <Accordion.Control>
                          <Text size="sm" fw={typography.fontWeight.medium}>
                            {tool.name}
                          </Text>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <Text size="xs" c={colors.text.secondary}>
                            {tool.description}
                          </Text>
                        </Accordion.Panel>
                      </Accordion.Item>
                    ))}
                    </Accordion>
                  )}
                </ScrollArea>
              </Card>
            </SimpleGrid>
          </Tabs.Panel>

          {/* Examples Tab */}
          <Tabs.Panel value="examples" pt={spacing[4]}>
            <Card
              padding={spacing[4]}
              radius={borderRadius.lg}
              style={{
                border: `1px solid ${colors.border.default}`,
                backgroundColor: colors.background.primary,
              }}
            >
              <Group justify="space-between" mb={spacing[4]}>
                <Text size="lg" fw={typography.fontWeight.semibold}>
                  Recent Event Examples
                </Text>
                <Badge variant="light" color="blue">
                  Live
                </Badge>
              </Group>

              <Stack gap={spacing[3]}>
                {isLoadingEvents ? (
                  Array.from({ length: 3 }).map((_, i) => <EventCardSkeleton key={i} />)
                ) : !recentEvents || recentEvents.length === 0 ? (
                  <Text size="sm" c={colors.text.tertiary} ta="center" p={spacing[6]}>
                    No recent events
                  </Text>
                ) : (
                  recentEvents.map((event) => (
                    <Card
                      key={event.id}
                      padding={spacing[3]}
                      style={{
                        backgroundColor: colors.background.secondary,
                        border: `1px solid ${colors.border.light}`,
                      }}
                    >
                      <Group justify="space-between" mb={spacing[2]}>
                        <Badge
                          variant="light"
                          color={event.isError ? 'red' : 'blue'}
                          size="sm"
                          style={{ fontFamily: typography.fontFamily.mono }}
                        >
                          {event.type}
                        </Badge>
                        <Text
                          size="xs"
                          c={colors.text.tertiary}
                          style={{ fontFamily: typography.fontFamily.mono }}
                        >
                          {new Date(event.timestamp).toLocaleString()}
                        </Text>
                      </Group>
                      <Code
                        block
                        style={{
                          fontSize: typography.fontSize.xs,
                          maxHeight: '100px',
                          overflow: 'auto',
                        }}
                      >
                        {JSON.stringify(
                          {
                            id: event.id,
                            userId: event.userId,
                            timestamp: event.timestamp,
                          },
                          null,
                          2
                        )}
                      </Code>
                    </Card>
                  ))
                )}
              </Stack>
            </Card>
          </Tabs.Panel>
        </Tabs>

        {/* Quick Actions */}
        <Card
          padding={spacing[4]}
          radius={borderRadius.lg}
          style={{
            border: `1px solid ${colors.border.default}`,
            backgroundColor: colors.background.primary,
          }}
        >
          <Text size="lg" fw={typography.fontWeight.semibold} mb={spacing[4]}>
            Quick Actions
          </Text>
          <Group gap={spacing[3]}>
            <Button
              variant="light"
              leftSection={<IconSearch size={18} />}
              onClick={() => navigate('/investigate')}
              aria-label="Navigate to investigate page"
            >
              Investigate Events
            </Button>
            <Button
              variant="light"
              leftSection={<IconFlask size={18} />}
              onClick={() => navigate('/testing')}
              aria-label="Navigate to testing page"
            >
              Test Tools
            </Button>
            <Button
              variant="light"
              leftSection={<IconTimeline size={18} />}
              onClick={() => navigate('/')}
              aria-label="Navigate to dashboard"
            >
              View Dashboard
            </Button>
          </Group>
        </Card>
      </Stack>
    </div>
  );
}

// Helper Components
const FlowStep = memo(function FlowStep({
  icon: Icon,
  label,
  color,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  color: string;
}) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          width: '80px',
          height: '80px',
          borderRadius: '50%',
          backgroundColor: `${color}20`,
          border: `2px solid ${color}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto',
        }}
      >
        <Icon size={32} color={color} />
      </div>
      <Text size="sm" fw={typography.fontWeight.medium} mt={spacing[2]}>
        {label}
      </Text>
    </div>
  );
});

const StatRow = memo(function StatRow({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <Group justify="space-between">
      <Text size="sm" c={colors.text.secondary}>
        {label}
      </Text>
      <Text size="sm" fw={typography.fontWeight.semibold} style={{ color: color || colors.text.primary }}>
        {value}
      </Text>
    </Group>
  );
});

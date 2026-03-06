import { useState } from "react";
import {
  Text,
  Badge,
  Tabs,
  Table,
  ActionIcon,
  Tooltip,
  Group,
  Loader,
  Stack,
  Paper,
  SimpleGrid,
  Progress,
  ThemeIcon,
  Button,
  Alert,
} from "@mantine/core";
import {
  IconActivity,
  IconRefresh,
  IconCircleCheck,
  IconCircleX,
  IconCircleDashed,
  IconAlertTriangle,
  IconBolt,
  IconChartBar,
  IconClock,
  IconPlugConnected,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
import { colors, spacing, typography } from "../../theme/tokens";

// ─── Types ────────────────────────────────────────────────────────────────────

type HealthStatus = "healthy" | "degraded" | "unhealthy" | null;

interface ServiceRecord {
  id: string;
  serviceId: string;
  name: string;
  capabilities: string[];
  pricing: string | null;
  version: string | null;
  webhookUrl: string | null;
  lastHealthCheck: Date | null;
  lastHealthStatus: HealthStatus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function healthColor(status: HealthStatus): string {
  switch (status) {
    case "healthy":
      return "green";
    case "degraded":
      return "yellow";
    case "unhealthy":
      return "red";
    default:
      return "gray";
  }
}

function HealthIcon({ status }: { status: HealthStatus }) {
  const iconProps = { size: 16 };
  switch (status) {
    case "healthy":
      return (
        <IconCircleCheck
          {...iconProps}
          color={colors.health?.healthy ?? "green"}
        />
      );
    case "degraded":
      return (
        <IconAlertTriangle
          {...iconProps}
          color={colors.health?.degraded ?? "orange"}
        />
      );
    case "unhealthy":
      return (
        <IconCircleX {...iconProps} color={colors.health?.critical ?? "red"} />
      );
    default:
      return (
        <IconCircleDashed
          {...iconProps}
          color={colors.text?.secondary ?? "gray"}
        />
      );
  }
}

function formatAge(date: Date | null): string {
  if (!date) return "Never";
  const ms = Date.now() - new Date(date).getTime();
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  if (sec < 60) return `${sec}s ago`;
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  return new Date(date).toLocaleDateString();
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

// ─── Metric Card ──────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  icon,
  color,
  sub,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
  sub?: string;
}) {
  return (
    <Paper
      p="md"
      radius="md"
      withBorder
      style={{ borderColor: colors.border?.default }}
    >
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            {label}
          </Text>
          <Text size="xl" fw={700}>
            {value}
          </Text>
          {sub && (
            <Text size="xs" c="dimmed">
              {sub}
            </Text>
          )}
        </Stack>
        <ThemeIcon variant="light" color={color} size="lg" radius="md">
          {icon}
        </ThemeIcon>
      </Group>
    </Paper>
  );
}

// ─── Services Tab ─────────────────────────────────────────────────────────────

function ServicesHealthTab() {
  const { data, isLoading, refetch } = trpc.capabilities.list.useQuery(
    undefined,
    { refetchInterval: 30_000 }
  );

  const checkHealthMutation = trpc.capabilities.checkHealth.useMutation({
    onSuccess: (result) => {
      refetch();
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

  const services = (data?.intelligenceServices ?? []) as ServiceRecord[];

  const healthyCount = services.filter(
    (s) => s.lastHealthStatus === "healthy"
  ).length;
  const degradedCount = services.filter(
    (s) => s.lastHealthStatus === "degraded"
  ).length;
  const unhealthyCount = services.filter(
    (s) => s.lastHealthStatus === "unhealthy"
  ).length;

  if (isLoading) return <Loader mt="xl" />;

  return (
    <Stack gap={spacing[6]}>
      {/* Summary */}
      <SimpleGrid cols={4}>
        <MetricCard
          label="Total Services"
          value={services.length}
          icon={<IconPlugConnected size={18} />}
          color="blue"
        />
        <MetricCard
          label="Healthy"
          value={healthyCount}
          icon={<IconCircleCheck size={18} />}
          color="green"
          sub={
            services.length > 0
              ? `${Math.round((healthyCount / services.length) * 100)}% uptime`
              : undefined
          }
        />
        <MetricCard
          label="Degraded"
          value={degradedCount}
          icon={<IconAlertTriangle size={18} />}
          color="yellow"
        />
        <MetricCard
          label="Unhealthy"
          value={unhealthyCount}
          icon={<IconCircleX size={18} />}
          color="red"
        />
      </SimpleGrid>

      {/* Alert when services are down */}
      {unhealthyCount > 0 && (
        <Alert
          icon={<IconAlertTriangle size={16} />}
          color="red"
          title="Services unreachable"
        >
          {unhealthyCount} intelligence service
          {unhealthyCount > 1 ? "s are" : " is"} unreachable. Affected
          workspaces fall back to the default Synap service automatically.
        </Alert>
      )}

      {/* Service table */}
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Service</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Health</Table.Th>
            <Table.Th>Last Check</Table.Th>
            <Table.Th>Capabilities</Table.Th>
            <Table.Th>Ping</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {services.map((svc) => (
            <Table.Tr key={svc.id}>
              <Table.Td>
                <Stack gap={2}>
                  <Text size="sm" fw={500}>
                    {svc.name}
                  </Text>
                  <Text
                    size="xs"
                    c="dimmed"
                    style={{ fontFamily: typography.fontFamily?.mono }}
                  >
                    {svc.serviceId}
                  </Text>
                </Stack>
              </Table.Td>
              <Table.Td>
                <Badge
                  size="xs"
                  variant="light"
                  color={svc.serviceId === "default" ? "blue" : "violet"}
                >
                  {svc.serviceId === "default" ? "built-in" : "external"}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Group gap={6}>
                  <HealthIcon status={svc.lastHealthStatus} />
                  <Badge
                    size="xs"
                    color={healthColor(svc.lastHealthStatus)}
                    variant="light"
                  >
                    {svc.lastHealthStatus ?? "unknown"}
                  </Badge>
                </Group>
              </Table.Td>
              <Table.Td>
                <Group gap={4}>
                  <IconClock size={12} color={colors.text?.secondary} />
                  <Text size="xs" c="dimmed">
                    {formatAge(svc.lastHealthCheck)}
                  </Text>
                </Group>
              </Table.Td>
              <Table.Td>
                <Group gap={4} wrap="wrap">
                  {(svc.capabilities ?? []).slice(0, 4).map((cap) => (
                    <Badge key={cap} size="xs" variant="outline" color="gray">
                      {cap}
                    </Badge>
                  ))}
                  {(svc.capabilities ?? []).length > 4 && (
                    <Text size="xs" c="dimmed">
                      +{svc.capabilities.length - 4}
                    </Text>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>
                {svc.serviceId !== "default" ? (
                  <Tooltip label="Ping /health endpoint now">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      loading={
                        checkHealthMutation.isPending &&
                        checkHealthMutation.variables?.serviceId ===
                          svc.serviceId
                      }
                      onClick={() =>
                        checkHealthMutation.mutate({ serviceId: svc.serviceId })
                      }
                    >
                      <IconRefresh size={14} />
                    </ActionIcon>
                  </Tooltip>
                ) : (
                  <Text size="xs" c="dimmed">
                    —
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
          {services.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={6}>
                <Text c="dimmed" ta="center" py={spacing[6]}>
                  No intelligence services registered.
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

// ─── Usage Tab ────────────────────────────────────────────────────────────────

function UsageTab() {
  const [days, setDays] = useState<30 | 7 | 1>(30);

  const { data, isLoading } = trpc.capabilities.serviceUsageStats.useQuery(
    { days },
    { refetchInterval: 60_000 }
  );

  const serviceListQuery = trpc.capabilities.list.useQuery();
  const serviceNames: Record<string, string> = Object.fromEntries(
    (serviceListQuery.data?.intelligenceServices ?? []).map((s) => [
      s.serviceId,
      s.name,
    ])
  );

  const stats = data?.stats ?? [];
  const totalMessages = stats.reduce((s, r) => s + r.messageCount, 0);
  const totalTokens = stats.reduce((s, r) => s + r.totalTokens, 0);
  const avgLatency =
    stats.length > 0
      ? Math.round(stats.reduce((s, r) => s + r.avgLatencyMs, 0) / stats.length)
      : 0;
  const maxMessages = Math.max(...stats.map((r) => r.messageCount), 1);

  if (isLoading) return <Loader mt="xl" />;

  return (
    <Stack gap={spacing[6]}>
      {/* Period selector */}
      <Group>
        <Text size="sm" fw={500}>
          Period:
        </Text>
        {([1, 7, 30] as const).map((d) => (
          <Button
            key={d}
            size="xs"
            variant={days === d ? "filled" : "light"}
            onClick={() => setDays(d)}
          >
            {d === 1 ? "24h" : `${d}d`}
          </Button>
        ))}
      </Group>

      {/* Summary cards */}
      <SimpleGrid cols={3}>
        <MetricCard
          label="Total Messages"
          value={totalMessages.toLocaleString()}
          icon={<IconBolt size={18} />}
          color="blue"
          sub={`last ${days === 1 ? "24h" : `${days} days`}`}
        />
        <MetricCard
          label="Total Tokens"
          value={formatTokens(totalTokens)}
          icon={<IconChartBar size={18} />}
          color="violet"
          sub="AI compute consumed"
        />
        <MetricCard
          label="Avg Latency"
          value={`${avgLatency}ms`}
          icon={<IconClock size={18} />}
          color={
            avgLatency > 3000 ? "red" : avgLatency > 1500 ? "yellow" : "green"
          }
          sub="per AI response"
        />
      </SimpleGrid>

      {/* Per-service breakdown */}
      {stats.length > 0 ? (
        <Paper
          p="md"
          radius="md"
          withBorder
          style={{ borderColor: colors.border?.default }}
        >
          <Text size="sm" fw={600} mb={spacing[4]}>
            Per-service breakdown
          </Text>
          <Stack gap={spacing[5]}>
            {stats.map((stat) => {
              const pct = Math.round((stat.messageCount / maxMessages) * 100);
              const name = serviceNames[stat.serviceId] ?? stat.serviceId;
              return (
                <Stack key={stat.serviceId} gap={4}>
                  <Group justify="space-between">
                    <Text size="sm">{name}</Text>
                    <Group gap={spacing[4]}>
                      <Text size="xs" c="dimmed">
                        {stat.messageCount.toLocaleString()} msgs
                      </Text>
                      <Text size="xs" c="dimmed">
                        {formatTokens(stat.totalTokens)} tok
                      </Text>
                      <Text size="xs" c="dimmed">
                        {stat.avgLatencyMs}ms
                      </Text>
                    </Group>
                  </Group>
                  <Progress value={pct} size="sm" radius="xl" />
                </Stack>
              );
            })}
          </Stack>
        </Paper>
      ) : (
        <Text c="dimmed" ta="center" py={spacing[6]}>
          No usage data for this period.
        </Text>
      )}
    </Stack>
  );
}

// ─── Page root ────────────────────────────────────────────────────────────────

export default function IntelligencePage() {
  return (
    <div style={{ padding: spacing[6] }}>
      {/* Header */}
      <Group mb={spacing[6]}>
        <IconActivity size={22} color={colors.eventTypes?.created} />
        <div>
          <Text size="xl" fw={700}>
            Intelligence Services
          </Text>
          <Text size="sm" c="dimmed">
            Health monitoring and aggregate token usage for all registered AI
            services. User-level data (commands, runs, memory, skills) lives
            inside each workspace, not here.
          </Text>
        </div>
      </Group>

      <Tabs defaultValue="services">
        <Tabs.List mb={spacing[4]}>
          <Tabs.Tab
            value="services"
            leftSection={<IconPlugConnected size={14} />}
          >
            Service Health
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconChartBar size={14} />}>
            Aggregate Usage
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="services">
          <ServicesHealthTab />
        </Tabs.Panel>
        <Tabs.Panel value="usage">
          <UsageTab />
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}

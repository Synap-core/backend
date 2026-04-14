import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Chip,
  ProgressBar,
  Spinner,
  Tabs,
  Text,
  Tooltip,
} from "@heroui/react";
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

function healthChipColor(
  status: HealthStatus
): "success" | "warning" | "danger" | "default" {
  switch (status) {
    case "healthy":
      return "success";
    case "degraded":
      return "warning";
    case "unhealthy":
      return "danger";
    default:
      return "default";
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

const metricIconTone: Record<string, { wrap: string; icon: string }> = {
  blue: { wrap: "bg-accent/15 text-accent", icon: "" },
  green: { wrap: "bg-success/15 text-success", icon: "" },
  yellow: { wrap: "bg-warning/15 text-warning", icon: "" },
  red: { wrap: "bg-danger/15 text-danger", icon: "" },
  violet: { wrap: "bg-accent/15 text-accent", icon: "" },
};

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
  const tone = metricIconTone[color] ?? metricIconTone.blue;
  return (
    <Card className="border border-divider p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Text className="text-xs font-semibold uppercase tracking-wide text-default-500">
            {label}
          </Text>
          <Text className="text-2xl font-bold text-foreground">{value}</Text>
          {sub ? <Text className="text-xs text-default-500">{sub}</Text> : null}
        </div>
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${tone.wrap}`}
        >
          {icon}
        </div>
      </div>
    </Card>
  );
}

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

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" color="accent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" style={{ gap: spacing[6] }}>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
      </div>

      {unhealthyCount > 0 ? (
        <Alert status="danger">
          <Alert.Indicator>
            <IconAlertTriangle size={16} />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>Services unreachable</Alert.Title>
            <Alert.Description>
              {unhealthyCount} intelligence service
              {unhealthyCount > 1 ? "s are" : " is"} unreachable. Affected
              workspaces fall back to the default Synap service automatically.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-divider">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-divider bg-default-50/80">
              <th className="px-3 py-2 font-medium">Service</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Health</th>
              <th className="px-3 py-2 font-medium">Last Check</th>
              <th className="px-3 py-2 font-medium">Capabilities</th>
              <th className="px-3 py-2 font-medium">Ping</th>
            </tr>
          </thead>
          <tbody>
            {services.map((svc) => (
              <tr
                key={svc.id}
                className="border-b border-divider/60 odd:bg-default-50/30 hover:bg-default-100/40"
              >
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <Text className="text-sm font-medium">{svc.name}</Text>
                    <span
                      className="text-xs text-default-500"
                      style={{ fontFamily: typography.fontFamily?.mono }}
                    >
                      {svc.serviceId}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Chip
                    size="sm"
                    variant="soft"
                    color={svc.serviceId === "default" ? "accent" : "warning"}
                  >
                    {svc.serviceId === "default" ? "built-in" : "external"}
                  </Chip>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <HealthIcon status={svc.lastHealthStatus} />
                    <Chip
                      size="sm"
                      variant="soft"
                      color={healthChipColor(svc.lastHealthStatus)}
                    >
                      {svc.lastHealthStatus ?? "unknown"}
                    </Chip>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1 text-xs text-default-500">
                    <IconClock size={12} color={colors.text?.secondary} />
                    {formatAge(svc.lastHealthCheck)}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(svc.capabilities ?? []).slice(0, 4).map((cap) => (
                      <Chip key={cap} size="sm" variant="soft" color="default">
                        {cap}
                      </Chip>
                    ))}
                    {(svc.capabilities ?? []).length > 4 ? (
                      <Text className="text-xs text-default-500">
                        +{svc.capabilities.length - 4}
                      </Text>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {svc.serviceId !== "default" ? (
                    <Tooltip>
                      <Tooltip.Trigger>
                        <Button
                          variant="ghost"
                          size="sm"
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
                          aria-label="Ping health endpoint"
                        >
                          {checkHealthMutation.isPending &&
                          checkHealthMutation.variables?.serviceId ===
                            svc.serviceId ? (
                            <Spinner size="sm" color="current" />
                          ) : (
                            <IconRefresh size={14} />
                          )}
                        </Button>
                      </Tooltip.Trigger>
                      <Tooltip.Content>
                        Ping /health endpoint now
                      </Tooltip.Content>
                    </Tooltip>
                  ) : (
                    <Text className="text-xs text-default-500">—</Text>
                  )}
                </td>
              </tr>
            ))}
            {services.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center">
                  <Text className="text-default-500">
                    No intelligence services registered.
                  </Text>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" color="accent" />
      </div>
    );
  }

  const latencyColor =
    avgLatency > 3000 ? "red" : avgLatency > 1500 ? "yellow" : "green";

  return (
    <div className="flex flex-col gap-6" style={{ gap: spacing[6] }}>
      <div className="flex flex-wrap items-center gap-2">
        <Text className="text-sm font-medium">Period:</Text>
        {([1, 7, 30] as const).map((d) => (
          <Button
            key={d}
            size="sm"
            variant={days === d ? "primary" : "ghost"}
            onPress={() => setDays(d)}
          >
            {d === 1 ? "24h" : `${d}d`}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
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
          color={latencyColor}
          sub="per AI response"
        />
      </div>

      {stats.length > 0 ? (
        <Card className="border border-divider p-4">
          <Text className="mb-4 text-sm font-semibold">
            Per-service breakdown
          </Text>
          <div className="flex flex-col gap-5" style={{ gap: spacing[5] }}>
            {stats.map((stat) => {
              const pct = Math.round((stat.messageCount / maxMessages) * 100);
              const name = serviceNames[stat.serviceId] ?? stat.serviceId;
              return (
                <div key={stat.serviceId} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Text className="text-sm">{name}</Text>
                    <div className="flex flex-wrap gap-4 text-xs text-default-500">
                      <span>{stat.messageCount.toLocaleString()} msgs</span>
                      <span>{formatTokens(stat.totalTokens)} tok</span>
                      <span>{stat.avgLatencyMs}ms</span>
                    </div>
                  </div>
                  <ProgressBar value={pct} minValue={0} maxValue={100} />
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <Text className="py-8 text-center text-default-500">
          No usage data for this period.
        </Text>
      )}
    </div>
  );
}

export default function IntelligencePage() {
  return (
    <div style={{ padding: spacing[6] }}>
      <div
        className="mb-6 flex items-start gap-3"
        style={{ marginBottom: spacing[6] }}
      >
        <IconActivity size={22} color={colors.eventTypes?.created} />
        <div>
          <Text className="text-xl font-bold">Intelligence Services</Text>
          <Text className="text-sm text-default-500">
            Health monitoring and aggregate token usage for all registered AI
            services. User-level data (commands, runs, memory, skills) lives
            inside each workspace, not here.
          </Text>
        </div>
      </div>

      <Tabs.Root defaultSelectedKey="services" orientation="horizontal">
        <Tabs.ListContainer>
          <Tabs.List className="mb-4 gap-1">
            <Tabs.Tab id="services" className="px-3 py-2 text-sm">
              <span className="inline-flex items-center gap-1">
                <IconPlugConnected size={14} />
                Service Health
              </span>
            </Tabs.Tab>
            <Tabs.Tab id="usage" className="px-3 py-2 text-sm">
              <span className="inline-flex items-center gap-1">
                <IconChartBar size={14} />
                Aggregate Usage
              </span>
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id="services" className="pt-1">
          <ServicesHealthTab />
        </Tabs.Panel>
        <Tabs.Panel id="usage" className="pt-1">
          <UsageTab />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}

import { Card, Text, Group, Stack, Badge, RingProgress } from "@mantine/core";
import {
  IconTrendingUp,
  IconTrendingDown,
  IconMinus,
} from "@tabler/icons-react";

interface MetricCardProps {
  title: string;
  value: string | number;
  unit?: string;
  trend?: "up" | "down" | "neutral";
  trendValue?: string;
  color?: string;
  description?: string;
  percentage?: number;
}

export default function MetricCard({
  title,
  value,
  unit,
  trend,
  trendValue,
  color = "blue",
  description,
  percentage,
}: MetricCardProps) {
  const TrendIcon =
    trend === "up"
      ? IconTrendingUp
      : trend === "down"
        ? IconTrendingDown
        : IconMinus;
  const trendColor =
    trend === "up" ? "green" : trend === "down" ? "red" : "gray";

  return (
    <Card withBorder padding="md">
      <Stack gap="xs">
        <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
          {title}
        </Text>

        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap="xs" align="baseline">
              <Text size="xl" fw={700} c={color}>
                {value}
              </Text>
              {unit && (
                <Text size="sm" c="dimmed">
                  {unit}
                </Text>
              )}
            </Group>
            {description && (
              <Text size="xs" c="dimmed" mt={4}>
                {description}
              </Text>
            )}
          </div>

          {percentage !== undefined && (
            <RingProgress
              size={60}
              thickness={6}
              roundCaps
              sections={[{ value: percentage, color }]}
              label={
                <Text size="xs" ta="center" fw={700}>
                  {percentage}%
                </Text>
              }
            />
          )}
        </Group>

        {trend && trendValue && (
          <Group gap="xs">
            <Badge
              variant="light"
              color={trendColor}
              leftSection={<TrendIcon size={12} />}
              size="sm"
            >
              {trendValue}
            </Badge>
            <Text size="xs" c="dimmed">
              vs last period
            </Text>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

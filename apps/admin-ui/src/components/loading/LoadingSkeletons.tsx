/**
 * Loading Skeleton Components
 *
 * Reusable skeleton components for consistent loading states across the application.
 */

import { Skeleton, Stack, Card, Group } from "@mantine/core";
import { spacing, borderRadius } from "../../theme/tokens";

/**
 * Skeleton for metric cards (Dashboard)
 */
export function MetricCardSkeleton() {
  return (
    <Card padding={spacing[4]} radius={borderRadius.lg}>
      <Group justify="space-between" mb={spacing[2]}>
        <Skeleton height={16} width={100} />
        <Skeleton height={20} width={20} circle />
      </Group>
      <Skeleton height={32} width={120} mb={spacing[1]} />
      <Skeleton height={12} width={150} />
    </Card>
  );
}

/**
 * Skeleton for event list items
 */
export function EventListItemSkeleton() {
  return (
    <div
      style={{
        padding: spacing[3],
        borderRadius: borderRadius.base,
        border: "1px solid #E5E7EB",
        display: "flex",
        alignItems: "center",
        gap: spacing[3],
      }}
    >
      <Skeleton height={24} width={120} />
      <div style={{ flex: 1 }}>
        <Skeleton height={14} width="60%" mb={spacing[1]} />
        <Skeleton height={12} width="40%" />
      </div>
      <Skeleton height={12} width={80} />
    </div>
  );
}

/**
 * Skeleton for event card (detailed)
 */
export function EventCardSkeleton() {
  return (
    <Card padding={spacing[3]} radius={borderRadius.base}>
      <Group justify="space-between" mb={spacing[2]}>
        <Skeleton height={24} width={120} />
        <Skeleton height={14} width={150} />
      </Group>
      <Skeleton height={14} width="80%" mb={spacing[1]} />
      <Skeleton height={12} width="60%" />
    </Card>
  );
}

/**
 * Skeleton for search results list
 */
export function SearchResultsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <Stack gap={spacing[2]}>
      {Array.from({ length: count }).map((_, i) => (
        <EventListItemSkeleton key={i} />
      ))}
    </Stack>
  );
}

/**
 * Skeleton for architecture component cards
 */
export function ArchitectureComponentSkeleton() {
  return (
    <Card padding={spacing[4]} radius={borderRadius.base}>
      <Group mb={spacing[3]}>
        <Skeleton height={24} width={24} circle />
        <Skeleton height={18} width={120} />
      </Group>
      <Skeleton height={14} width="100%" mb={spacing[3]} />
      <Group gap={spacing[4]}>
        <div>
          <Skeleton height={12} width={80} mb={spacing[1]} />
          <Skeleton height={20} width={60} />
        </div>
        <div>
          <Skeleton height={12} width={80} mb={spacing[1]} />
          <Skeleton height={20} width={60} />
        </div>
      </Group>
    </Card>
  );
}

/**
 * Skeleton for tool accordion items
 */
export function ToolAccordionSkeleton() {
  return (
    <Stack gap={spacing[2]}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i}>
          <Skeleton height={40} width="100%" radius={borderRadius.base} />
        </div>
      ))}
    </Stack>
  );
}

/**
 * Skeleton for code block
 */
export function CodeBlockSkeleton() {
  return (
    <div
      style={{
        padding: spacing[3],
        backgroundColor: "#F9FAFB",
        borderRadius: borderRadius.base,
      }}
    >
      <Skeleton height={12} width="100%" mb={spacing[1]} />
      <Skeleton height={12} width="90%" mb={spacing[1]} />
      <Skeleton height={12} width="95%" mb={spacing[1]} />
      <Skeleton height={12} width="85%" />
    </div>
  );
}

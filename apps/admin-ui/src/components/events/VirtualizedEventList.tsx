/**
 * VirtualizedEventList Component
 *
 * A virtualized list component for rendering large event lists efficiently.
 * Uses @tanstack/react-virtual to only render visible items.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { Badge, Text, Group } from "@mantine/core";
import { colors, typography, spacing, borderRadius } from "../../theme/tokens";
import EventContextMenu from "./EventContextMenu";

interface Event {
  eventId: string;
  eventType: string;
  timestamp: string;
  userId?: string;
  isError?: boolean;
  correlationId?: string;
  data?: Record<string, unknown>;
}

interface VirtualizedEventListProps {
  events: Event[];
  onEventClick?: (eventId: string) => void;
  onPublishSimilar?: (event: Event) => void;
}

export default function VirtualizedEventList({
  events,
  onEventClick,
  onPublishSimilar,
}: VirtualizedEventListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60, // Estimated height of each event item
    overscan: 5, // Render 5 extra items outside viewport
  });

  return (
    <div
      ref={parentRef}
      style={{
        height: "400px",
        overflow: "auto",
      }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const event = events[virtualItem.index];
          return (
            <div
              key={event.eventId}
              onClick={() => onEventClick?.(event.eventId)}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
                padding: spacing[3],
                borderRadius: borderRadius.base,
                border: `1px solid ${colors.border.light}`,
                backgroundColor: event.isError
                  ? "#FEF2F2"
                  : colors.background.secondary,
                display: "flex",
                alignItems: "center",
                gap: spacing[3],
                cursor: onEventClick ? "pointer" : "default",
                transition: "background-color 0.1s ease",
              }}
              onMouseEnter={(e) => {
                if (onEventClick) {
                  e.currentTarget.style.backgroundColor =
                    colors.background.hover;
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = event.isError
                  ? "#FEF2F2"
                  : colors.background.secondary;
              }}
            >
              <Badge
                variant="light"
                color={event.isError ? "red" : "blue"}
                size="sm"
                style={{
                  minWidth: "120px",
                  fontFamily: typography.fontFamily.mono,
                }}
              >
                {event.eventType}
              </Badge>
              <div style={{ flex: 1 }}>
                <Text
                  size="sm"
                  c={colors.text.primary}
                  style={{ fontFamily: typography.fontFamily.mono }}
                >
                  {event.eventId}
                </Text>
                {event.userId && (
                  <Text size="xs" c={colors.text.secondary} mt={2}>
                    User: {event.userId}
                  </Text>
                )}
              </div>
              <Group gap={spacing[2]}>
                <Text
                  size="xs"
                  c={colors.text.tertiary}
                  style={{ fontFamily: typography.fontFamily.mono }}
                >
                  {new Date(event.timestamp).toLocaleTimeString()}
                </Text>
                <EventContextMenu
                  event={event}
                  onPublishSimilar={onPublishSimilar}
                />
              </Group>
            </div>
          );
        })}
      </div>
    </div>
  );
}

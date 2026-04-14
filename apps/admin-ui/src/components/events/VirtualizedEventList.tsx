/**
 * Virtualized event list — TanStack Virtual + Tailwind + Hero UI chips.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { Chip } from "@heroui/react";
import { spacing, borderRadius, typography } from "../../theme/tokens";
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
}

export default function VirtualizedEventList({
  events,
  onEventClick,
}: VirtualizedEventListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 5,
  });

  return (
    <div ref={parentRef} className="h-[400px] overflow-auto">
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const event = events[virtualItem.index];
          return (
            <div
              key={event.eventId}
              role={onEventClick ? "button" : undefined}
              tabIndex={onEventClick ? 0 : undefined}
              onClick={() => onEventClick?.(event.eventId)}
              onKeyDown={(e) => {
                if (onEventClick && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onEventClick(event.eventId);
                }
              }}
              className={`absolute left-0 top-0 flex w-full items-center gap-3 border transition-colors ${
                event.isError
                  ? "border-danger-200 bg-danger-50 hover:bg-danger-100/80"
                  : "border-divider bg-default-100 hover:bg-default-200/80"
              } ${onEventClick ? "cursor-pointer" : ""} `}
              style={{
                height: virtualItem.size,
                transform: `translateY(${virtualItem.start}px)`,
                padding: spacing[3],
                borderRadius: borderRadius.base,
              }}
            >
              <Chip
                size="sm"
                variant="soft"
                color={event.isError ? "danger" : "accent"}
                className="min-w-[120px] shrink-0 justify-center font-mono text-xs"
              >
                {event.eventType}
              </Chip>
              <div className="min-w-0 flex-1">
                <div
                  className="truncate font-mono text-small text-foreground"
                  style={{ fontFamily: typography.fontFamily.mono }}
                >
                  {event.eventId}
                </div>
                {event.userId ? (
                  <div className="mt-0.5 truncate font-mono text-xs text-default-500">
                    User: {event.userId}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className="whitespace-nowrap font-mono text-xs text-default-400"
                  style={{ fontFamily: typography.fontFamily.mono }}
                >
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
                <EventContextMenu event={event} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

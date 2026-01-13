import {
  Card,
  Group,
  Badge,
  Text,
  Stack,
  Code,
  Collapse,
  Button,
} from "@mantine/core";
import { useState, memo } from "react";
import {
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconUser,
  IconHash,
} from "@tabler/icons-react";
import { formatDistanceToNow } from "date-fns";

interface EventCardProps {
  event: {
    id: string;
    type: string;
    timestamp: string;
    userId: string;
    aggregateId?: string;
    aggregateType?: string;
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    causationId?: string | null;
    correlationId?: string | null;
    source?: string;
  };
  isHighlighted?: boolean;
  onClick?: () => void;
}

function EventCard({ event, isHighlighted, onClick }: EventCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card
      withBorder
      padding="md"
      bg={isHighlighted ? "blue.0" : undefined}
      style={{
        cursor: onClick ? "pointer" : undefined,
        transition: "all 0.2s",
      }}
      onClick={onClick}
    >
      <Stack gap="sm">
        {/* Header */}
        <Group justify="space-between">
          <Group gap="xs">
            <Badge variant="light" color="blue">
              {event.type}
            </Badge>
            {event.source && (
              <Badge variant="outline" color="gray" size="sm">
                {event.source}
              </Badge>
            )}
          </Group>
          <Group gap="xs">
            <IconClock size={14} />
            <Text size="xs" c="dimmed">
              {formatDistanceToNow(new Date(event.timestamp), {
                addSuffix: true,
              })}
            </Text>
          </Group>
        </Group>

        {/* Metadata */}
        <Group gap="md">
          <Group gap="xs">
            <IconUser size={14} />
            <Text size="sm" ff="monospace">
              {event.userId}
            </Text>
          </Group>
          {event.aggregateId && (
            <Group gap="xs">
              <IconHash size={14} />
              <Text size="sm" c="dimmed">
                {event.aggregateType}: {event.aggregateId.slice(0, 8)}...
              </Text>
            </Group>
          )}
        </Group>

        {/* Correlation IDs */}
        {(event.correlationId || event.causationId) && (
          <Group gap="md">
            {event.correlationId && (
              <Text size="xs" c="dimmed">
                Correlation: <Code>{event.correlationId.slice(0, 8)}...</Code>
              </Text>
            )}
            {event.causationId && (
              <Text size="xs" c="dimmed">
                Causation: <Code>{event.causationId.slice(0, 8)}...</Code>
              </Text>
            )}
          </Group>
        )}

        {/* Toggle Details */}
        <Button
          variant="subtle"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          rightSection={
            expanded ? (
              <IconChevronUp size={14} />
            ) : (
              <IconChevronDown size={14} />
            )
          }
        >
          {expanded ? "Hide" : "Show"} Details
        </Button>

        {/* Expanded Content */}
        <Collapse in={expanded}>
          <Stack gap="xs">
            <div>
              <Text size="sm" fw={500} mb="xs">
                Event Data
              </Text>
              <Code block style={{ fontSize: "12px" }}>
                {JSON.stringify(event.data, null, 2)}
              </Code>
            </div>
            {event.metadata && Object.keys(event.metadata).length > 0 && (
              <div>
                <Text size="sm" fw={500} mb="xs">
                  Metadata
                </Text>
                <Code block style={{ fontSize: "12px" }}>
                  {JSON.stringify(event.metadata, null, 2)}
                </Code>
              </div>
            )}
            <Group gap="md">
              <Text size="xs" c="dimmed">
                Event ID: <Code>{event.id}</Code>
              </Text>
              <Text size="xs" c="dimmed">
                Timestamp: {new Date(event.timestamp).toLocaleString()}
              </Text>
            </Group>
          </Stack>
        </Collapse>
      </Stack>
    </Card>
  );
}

export default memo(EventCard);

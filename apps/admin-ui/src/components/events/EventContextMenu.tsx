import { Menu, ActionIcon } from '@mantine/core';
import {
  IconDots,
  IconSearch,
  IconTimeline,
  IconCopy,
  IconExternalLink,
} from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';

interface Event {
  eventId: string;
  eventType: string;
  timestamp: string;
  userId?: string;
  correlationId?: string;
  data?: Record<string, unknown>;
}

interface EventContextMenuProps {
  event: Event;
  onPublishSimilar?: (event: Event) => void;
}

export default function EventContextMenu({ event, onPublishSimilar }: EventContextMenuProps) {
  const navigate = useNavigate();

  const handleInspect = () => {
    navigate(`/investigate?eventId=${encodeURIComponent(event.eventId)}`);
  };

  const handleViewTrace = () => {
    if (event.correlationId) {
      navigate(`/investigate?correlationId=${encodeURIComponent(event.correlationId)}`);
    } else {
      navigate(`/investigate?eventId=${encodeURIComponent(event.eventId)}`);
    }
  };

  const handlePublishSimilar = () => {
    if (onPublishSimilar) {
      onPublishSimilar(event);
    } else {
      // Navigate to event publisher with pre-filled data
      const eventData = JSON.stringify(event.data || {}, null, 2);
      navigate(`/publish?type=${encodeURIComponent(event.eventType)}&data=${encodeURIComponent(eventData)}&userId=${encodeURIComponent(event.userId || '')}`);
    }
  };

  const handleCopyEventId = () => {
    navigator.clipboard.writeText(event.eventId);
  };

  return (
    <Menu shadow="md" width={200} position="bottom-end">
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          size="sm"
          onClick={(e) => e.stopPropagation()}
          aria-label="Event actions"
        >
          <IconDots size={16} />
        </ActionIcon>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>Actions</Menu.Label>
        <Menu.Item
          leftSection={<IconSearch size={16} />}
          onClick={(e) => {
            e.stopPropagation();
            handleInspect();
          }}
        >
          Inspect in Detail
        </Menu.Item>
        <Menu.Item
          leftSection={<IconTimeline size={16} />}
          onClick={(e) => {
            e.stopPropagation();
            handleViewTrace();
          }}
          disabled={!event.correlationId && !event.eventId}
        >
          View Full Trace
        </Menu.Item>
        <Menu.Item
          leftSection={<IconCopy size={16} />}
          onClick={(e) => {
            e.stopPropagation();
            handlePublishSimilar();
          }}
        >
          Publish Similar Event
        </Menu.Item>

        <Menu.Divider />

        <Menu.Label>Utilities</Menu.Label>
        <Menu.Item
          leftSection={<IconExternalLink size={16} />}
          onClick={(e) => {
            e.stopPropagation();
            handleCopyEventId();
          }}
        >
          Copy Event ID
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}


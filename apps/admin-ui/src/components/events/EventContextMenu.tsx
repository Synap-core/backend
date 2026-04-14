import { Button } from "@heroui/react";
import { Dropdown } from "@heroui/react";
import {
  IconDots,
  IconSearch,
  IconTimeline,
  IconCopy,
} from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";

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
}

export default function EventContextMenu({ event }: EventContextMenuProps) {
  const navigate = useNavigate();

  const handleInspect = () => {
    navigate(`/events?eventId=${encodeURIComponent(event.eventId)}`);
  };

  const handleViewTrace = () => {
    if (event.correlationId) {
      navigate(
        `/events?correlationId=${encodeURIComponent(event.correlationId)}`
      );
    } else {
      navigate(`/events?eventId=${encodeURIComponent(event.eventId)}`);
    }
  };

  const handleCopyEventId = () => {
    void navigator.clipboard.writeText(event.eventId);
  };

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Dropdown.Root>
        <Dropdown.Trigger>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Event actions"
          >
            <IconDots size={16} />
          </Button>
        </Dropdown.Trigger>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            onAction={(key) => {
              if (key === "inspect") handleInspect();
              else if (key === "trace") handleViewTrace();
              else if (key === "copy") handleCopyEventId();
            }}
          >
            <Dropdown.Item id="inspect" textValue="Inspect in detail">
              <span className="inline-flex items-center gap-2">
                <IconSearch size={16} />
                Inspect in detail
              </span>
            </Dropdown.Item>
            <Dropdown.Item
              id="trace"
              textValue="View full trace"
              isDisabled={!event.correlationId && !event.eventId}
            >
              <span className="inline-flex items-center gap-2">
                <IconTimeline size={16} />
                View full trace
              </span>
            </Dropdown.Item>
            <Dropdown.Item id="copy" textValue="Copy event ID">
              <span className="inline-flex items-center gap-2">
                <IconCopy size={16} />
                Copy event ID
              </span>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
    </div>
  );
}

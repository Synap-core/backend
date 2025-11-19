import { useState, useEffect } from 'react';
import {
  Container,
  Title,
  Card,
  Text,
  Badge,
  Stack,
  Group,
  Button,
  TextInput,
  Modal,
  Code,
  ScrollArea,
} from '@mantine/core';
import { IconRefresh, IconSearch } from '@tabler/icons-react';

interface EventData {
  id: string;
  type: string;
  timestamp: string;
  userId: string;
  aggregateId: string;
  aggregateType: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  source: string;
  version: number;
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export default function EventStreamPage() {
  const [events, setEvents] = useState<EventData[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedEvent, setSelectedEvent] = useState<EventData | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    // Connect to SSE endpoint
    const eventSource = new EventSource(`${API_URL}/api/events/stream`);

    eventSource.onopen = () => {
      console.log('SSE connection opened');
      setIsConnected(true);
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Skip connection message
        if (data.type === 'connected') {
          console.log('SSE client ID:', data.clientId);
          return;
        }

        // Add new event to the top of the list
        setEvents((prev) => [data, ...prev].slice(0, 100)); // Keep only last 100 events
      } catch (error) {
        console.error('Failed to parse event:', error);
      }
    };

    eventSource.onerror = () => {
      console.error('SSE connection error');
      setIsConnected(false);
    };

    // Cleanup on unmount
    return () => {
      eventSource.close();
      setIsConnected(false);
    };
  }, []);

  const filteredEvents = events.filter((event) => {
    if (!filter) return true;
    const searchLower = filter.toLowerCase();
    return (
      event.type.toLowerCase().includes(searchLower) ||
      event.userId.toLowerCase().includes(searchLower) ||
      event.aggregateType?.toLowerCase().includes(searchLower)
    );
  });

  const handleRefresh = () => {
    setEvents([]);
  };

  const getEventColor = (type: string) => {
    if (type.includes('error') || type.includes('failed')) return 'red';
    if (type.includes('completed') || type.includes('success')) return 'green';
    if (type.includes('requested') || type.includes('started')) return 'blue';
    return 'gray';
  };

  return (
    <Container size="xl">
      <Stack gap="md">
        <Group justify="space-between">
          <div>
            <Title order={1}>Live Event Stream</Title>
            <Text size="sm" c="dimmed">
              Real-time event monitoring via Server-Sent Events
            </Text>
          </div>
          <Group>
            <Badge color={isConnected ? 'green' : 'red'} variant="light">
              {isConnected ? 'Connected' : 'Disconnected'}
            </Badge>
            <Button
              leftSection={<IconRefresh size={16} />}
              variant="light"
              onClick={handleRefresh}
            >
              Clear
            </Button>
          </Group>
        </Group>

        <TextInput
          placeholder="Filter by event type, user ID, or aggregate type..."
          leftSection={<IconSearch size={16} />}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />

        <Text size="sm" c="dimmed">
          {filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''} (
          {events.length} total)
        </Text>

        <ScrollArea h="calc(100vh - 300px)">
          <Stack gap="sm">
            {filteredEvents.length === 0 ? (
              <Card withBorder>
                <Text c="dimmed" ta="center">
                  {events.length === 0
                    ? 'Waiting for events... Try triggering some actions in your application.'
                    : 'No events match your filter.'}
                </Text>
              </Card>
            ) : (
              filteredEvents.map((event) => (
                <Card
                  key={event.id}
                  withBorder
                  padding="md"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelectedEvent(event)}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Group gap="xs" wrap="nowrap">
                        <Badge color={getEventColor(event.type)} variant="light">
                          {event.type}
                        </Badge>
                        <Text size="xs" c="dimmed" truncate>
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </Text>
                      </Group>
                      <Group gap="xs" mt="xs">
                        <Text size="xs" c="dimmed">
                          User: {event.userId.substring(0, 8)}...
                        </Text>
                        {event.aggregateType && (
                          <Text size="xs" c="dimmed">
                            | Type: {event.aggregateType}
                          </Text>
                        )}
                        {event.correlationId && (
                          <Text size="xs" c="dimmed">
                            | Corr: {event.correlationId.substring(0, 8)}...
                          </Text>
                        )}
                      </Group>
                    </div>
                    <Button size="xs" variant="subtle">
                      Inspect
                    </Button>
                  </Group>
                </Card>
              ))
            )}
          </Stack>
        </ScrollArea>
      </Stack>

      {/* Event Inspector Modal */}
      <Modal
        opened={selectedEvent !== null}
        onClose={() => setSelectedEvent(null)}
        title="Event Inspector"
        size="xl"
      >
        {selectedEvent && (
          <Stack gap="md">
            <div>
              <Text size="sm" fw={500}>
                Event Type
              </Text>
              <Badge color={getEventColor(selectedEvent.type)} mt="xs">
                {selectedEvent.type}
              </Badge>
            </div>

            <div>
              <Text size="sm" fw={500}>
                Metadata
              </Text>
              <Group gap="xs" mt="xs">
                <Badge variant="outline">ID: {selectedEvent.id}</Badge>
                <Badge variant="outline">
                  Time: {new Date(selectedEvent.timestamp).toLocaleString()}
                </Badge>
                <Badge variant="outline">Source: {selectedEvent.source}</Badge>
              </Group>
            </div>

            {selectedEvent.correlationId && (
              <div>
                <Text size="sm" fw={500}>
                  Correlation ID
                </Text>
                <Code block mt="xs">
                  {selectedEvent.correlationId}
                </Code>
              </div>
            )}

            <div>
              <Text size="sm" fw={500}>
                Payload
              </Text>
              <Code block mt="xs">
                {JSON.stringify(selectedEvent.data, null, 2)}
              </Code>
            </div>

            {selectedEvent.metadata && (
              <div>
                <Text size="sm" fw={500}>
                  System Metadata
                </Text>
                <Code block mt="xs">
                  {JSON.stringify(selectedEvent.metadata, null, 2)}
                </Code>
              </div>
            )}
          </Stack>
        )}
      </Modal>
    </Container>
  );
}

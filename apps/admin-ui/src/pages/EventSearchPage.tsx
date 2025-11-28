import { useState } from 'react';
import {
  Container,
  Title,
  Text,
  Stack,
  Alert,
  Loader,
  Table,
  Group,
  Badge,
  Button,
  Card,
  Code,
} from '@mantine/core';
import {
  IconInfoCircle,
  IconAlertCircle,
  IconDownload,
  IconEye,
} from '@tabler/icons-react';
import { trpc } from '../lib/trpc';
import SearchFilters from '../components/search/SearchFilters';
import type { SearchFiltersState } from '../components/search/SearchFilters';
import EventCard from '../components/trace/EventCard';

export default function EventSearchPage() {
  const [currentFilters, setCurrentFilters] = useState<SearchFiltersState | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<{
    id: string;
    type: string;
    timestamp: string;
    userId: string;
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  } | null>(null);

  const { data: capabilities } = trpc.system.getCapabilities.useQuery();

  // Build query input from current filters
  const queryInput = currentFilters
    ? {
        userId: currentFilters.userId,
        eventType: currentFilters.eventType,
        aggregateType: currentFilters.aggregateType,
        aggregateId: currentFilters.aggregateId,
        correlationId: currentFilters.correlationId,
        fromDate: currentFilters.fromDate?.toISOString(),
        toDate: currentFilters.toDate?.toISOString(),
        limit: currentFilters.limit,
        offset: currentFilters.offset,
      }
    : undefined;

  const { data, isLoading, error } = trpc.system.searchEvents.useQuery(
    queryInput || {},
    {
      enabled: !!currentFilters,
    }
  );

  const handleSearch = (filters: SearchFiltersState) => {
    setCurrentFilters(filters);
    setSelectedEvent(null);
  };

  const handleReset = () => {
    setCurrentFilters(null);
    setSelectedEvent(null);
  };

  const handleExport = () => {
    if (!data?.events) return;

    const jsonStr = JSON.stringify(data.events, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `events-export-${new Date().toISOString()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const eventTypes = capabilities?.eventTypes.map((et) => et.type) || [];

  return (
    <Container size="xl">
      <Stack gap="xl">
        <div>
          <Title order={1}>Event Store Advanced Search</Title>
          <Text size="sm" c="dimmed">
            SQL-like querying of the event store with powerful filtering
          </Text>
        </div>

        <Alert icon={<IconInfoCircle size={16} />} title="Search Capabilities" color="blue">
          Use filters to search events by user, type, aggregate, correlation ID, or date range.
          Results can be exported as JSON for analysis.
        </Alert>

        {/* Search Filters */}
        <SearchFilters
          onSearch={handleSearch}
          onReset={handleReset}
          isLoading={isLoading}
          eventTypes={eventTypes}
        />

        {/* Loading State */}
        {isLoading && (
          <Stack align="center" justify="center" h={200}>
            <Loader size="lg" />
            <Text c="dimmed">Searching events...</Text>
          </Stack>
        )}

        {/* Error State */}
        {error && (
          <Alert icon={<IconAlertCircle size={16} />} title="Error" color="red">
            Failed to search events: {(error as unknown as Error).message}
          </Alert>
        )}

        {/* Results */}
        {!isLoading && !error && data && (
          <Stack gap="md">
            {/* Results Header */}
            <Card withBorder padding="md">
              <Group justify="space-between">
                <div>
                  <Text fw={500}>Search Results</Text>
                  <Text size="sm" c="dimmed">
                    Found {data.events.length} events
                    {data.pagination.hasMore && ' (showing first page)'}
                  </Text>
                </div>
                <Group>
                  {data.pagination.hasMore && (
                    <Button
                      variant="subtle"
                      size="sm"
                      onClick={() => {
                        if (currentFilters) {
                          handleSearch({
                            ...currentFilters,
                            offset: currentFilters.offset + currentFilters.limit,
                          });
                        }
                      }}
                    >
                      Load More
                    </Button>
                  )}
                  <Button
                    variant="light"
                    size="sm"
                    onClick={handleExport}
                    leftSection={<IconDownload size={16} />}
                  >
                    Export JSON
                  </Button>
                </Group>
              </Group>
            </Card>

            {/* Results Table */}
            {data.events.length === 0 ? (
              <Alert icon={<IconInfoCircle size={16} />} title="No Results" color="yellow">
                No events found matching your search criteria.
              </Alert>
            ) : (
              <>
                {/* Compact Table View */}
                <Card withBorder padding="md">
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Timestamp</Table.Th>
                        <Table.Th>Event Type</Table.Th>
                        <Table.Th>User ID</Table.Th>
                        <Table.Th>Aggregate</Table.Th>
                        <Table.Th>Action</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {data.events.map((event) => (
                        <Table.Tr key={event.id}>
                          <Table.Td>
                            <Text size="xs" ff="monospace">
                              {new Date(event.timestamp).toLocaleString()}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge variant="light" size="sm">
                              {event.type}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Code>{event.userId.slice(0, 12)}...</Code>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed">
                              {event.aggregateType || 'N/A'}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Button
                              size="xs"
                              variant="subtle"
                              onClick={() => setSelectedEvent(event)}
                              leftSection={<IconEye size={14} />}
                            >
                              View
                            </Button>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Card>

                {/* Selected Event Details */}
                {selectedEvent && (
                  <div>
                    <Group justify="space-between" mb="md">
                      <Text fw={500}>Event Details</Text>
                      <Button size="xs" variant="subtle" onClick={() => setSelectedEvent(null)}>
                        Close
                      </Button>
                    </Group>
                    <EventCard event={selectedEvent} isHighlighted />
                  </div>
                )}
              </>
            )}

            {/* Pagination Info */}
            {data.pagination.total > 0 && (
              <Card withBorder padding="sm">
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    Showing {data.pagination.offset + 1} -{' '}
                    {Math.min(
                      data.pagination.offset + data.pagination.limit,
                      data.pagination.total
                    )}{' '}
                    of {data.pagination.total} total events
                  </Text>
                  {currentFilters && currentFilters.offset > 0 && (
                    <Button
                      variant="subtle"
                      size="sm"
                      onClick={() => {
                        handleSearch({
                          ...currentFilters,
                          offset: Math.max(0, currentFilters.offset - currentFilters.limit),
                        });
                      }}
                    >
                      Previous Page
                    </Button>
                  )}
                </Group>
              </Card>
            )}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

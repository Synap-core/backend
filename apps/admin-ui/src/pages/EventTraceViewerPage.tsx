import { useState } from 'react';
import {
  Container,
  Title,
  Text,
  Stack,
  TextInput,
  Group,
  Button,
  SegmentedControl,
  Alert,
  Loader,
  Tabs,
} from '@mantine/core';
import {
  IconSearch,
  IconTimeline,
  IconGraph,
  IconInfoCircle,
  IconAlertCircle,
} from '@tabler/icons-react';
import { trpc } from '../lib/trpc';
import EventCard from '../components/trace/EventCard';
import CorrelationGraph from '../components/trace/CorrelationGraph';

export default function EventTraceViewerPage() {
  const [searchType, setSearchType] = useState<'correlationId' | 'userId' | 'eventId'>(
    'correlationId'
  );
  const [searchValue, setSearchValue] = useState('');
  const [executeSearch, setExecuteSearch] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Build search filters based on search type
  const searchFilters =
    executeSearch && searchValue
      ? {
          correlationId: searchType === 'correlationId' ? searchValue : undefined,
          userId: searchType === 'userId' ? searchValue : undefined,
          limit: searchType === 'eventId' ? 1 : 100,
        }
      : undefined;

  const { data, isLoading, error } = trpc.system.searchEvents.useQuery(
    searchFilters || {},
    {
      enabled: executeSearch && !!searchValue,
    }
  );

  const handleSearch = () => {
    if (searchValue.trim()) {
      setExecuteSearch(true);
      setSelectedEventId(null);
    }
  };

  const events = data?.events || [];

  // For single event ID search, also fetch related events by correlation
  const singleEvent = searchType === 'eventId' && events.length === 1 ? events[0] : null;

  const { data: relatedData } = trpc.system.searchEvents.useQuery(
    {
      correlationId: singleEvent?.correlationId || '',
      limit: 100,
    },
    {
      enabled: !!singleEvent?.correlationId,
    }
  );

  const displayEvents =
    searchType === 'eventId' && relatedData ? relatedData.events : events;

  return (
    <Container size="xl">
      <Stack gap="xl">
        <div>
          <Title order={1}>Event Trace Viewer</Title>
          <Text size="sm" c="dimmed">
            Trace user workflows and debug event flows by exploring event chains
          </Text>
        </div>

        <Alert icon={<IconInfoCircle size={16} />} title="How to Use" color="blue">
          Search by <strong>Correlation ID</strong> to see all events in a workflow,{' '}
          <strong>User ID</strong> to see all events for a user, or <strong>Event ID</strong> to
          trace a specific event and its related events.
        </Alert>

        {/* Search Controls */}
        <Stack gap="md">
          <SegmentedControl
            value={searchType}
            onChange={(value) => {
              setSearchType(value as 'correlationId' | 'userId' | 'eventId');
              setExecuteSearch(false);
            }}
            data={[
              { label: 'Correlation ID', value: 'correlationId' },
              { label: 'User ID', value: 'userId' },
              { label: 'Event ID', value: 'eventId' },
            ]}
          />

          <Group>
            <TextInput
              style={{ flex: 1 }}
              placeholder={
                searchType === 'correlationId'
                  ? 'Enter correlation ID...'
                  : searchType === 'userId'
                    ? 'Enter user ID...'
                    : 'Enter event ID...'
              }
              value={searchValue}
              onChange={(e) => setSearchValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSearch();
                }
              }}
              leftSection={<IconSearch size={16} />}
            />
            <Button onClick={handleSearch} disabled={!searchValue.trim()} loading={isLoading}>
              Search
            </Button>
          </Group>
        </Stack>

        {/* Loading State */}
        {isLoading && (
          <Stack align="center" justify="center" h={300}>
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
        {!isLoading && !error && executeSearch && displayEvents.length === 0 && (
          <Alert icon={<IconInfoCircle size={16} />} title="No Results" color="yellow">
            No events found for the given search criteria.
          </Alert>
        )}

        {!isLoading && !error && displayEvents.length > 0 && (
          <Tabs defaultValue="timeline">
            <Tabs.List>
              <Tabs.Tab value="timeline" leftSection={<IconTimeline size={16} />}>
                Timeline View ({displayEvents.length})
              </Tabs.Tab>
              <Tabs.Tab value="graph" leftSection={<IconGraph size={16} />}>
                Flow Graph
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="timeline" pt="md">
              <Stack gap="md">
                {singleEvent && (
                  <Alert icon={<IconInfoCircle size={16} />} color="blue">
                    Showing event and {displayEvents.length - 1} related events in the same
                    workflow
                  </Alert>
                )}
                {displayEvents.map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    isHighlighted={selectedEventId === event.id}
                    onClick={() => setSelectedEventId(event.id)}
                  />
                ))}
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="graph" pt="md">
              <CorrelationGraph
                events={displayEvents}
                onEventClick={setSelectedEventId}
                highlightedEventId={selectedEventId || undefined}
              />
            </Tabs.Panel>
          </Tabs>
        )}
      </Stack>
    </Container>
  );
}

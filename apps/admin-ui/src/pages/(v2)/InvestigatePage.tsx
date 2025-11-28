import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Title,
  Text,
  Stack,
  Card,
  TextInput,
  Select,
  Button,
  Group,
  Badge,
  Timeline,
  Drawer,
  ScrollArea,
  Code,
  Divider,
  Skeleton,
} from '@mantine/core';
import {
  IconSearch,
  IconFilter,
  IconTimeline,
  IconArrowRight,
  IconClock,
  IconUser,
  IconTag,
  IconCode,
} from '@tabler/icons-react';
import { colors, typography, spacing, borderRadius } from '../../theme/tokens';
import { trpc } from '../../lib/trpc';
import { SearchResultsSkeleton } from '../../components/loading/LoadingSkeletons';

export default function InvestigatePage() {
  const [searchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState(searchParams.get('userId') || searchParams.get('eventId') || '');
  const [eventTypeFilter, setEventTypeFilter] = useState<string | null>(searchParams.get('eventType'));
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Fetch events based on search
  const { data, refetch: refetchEvents, isLoading } = trpc.system.searchEvents.useQuery(
    {
      limit: 50,
      userId: searchTerm && !searchTerm.match(/^[0-9a-f-]{36}$/i) ? searchTerm : undefined,
      eventType: eventTypeFilter || undefined,
    },
    {
      enabled: true,
    }
  );

  const events = data?.events;

  // Fetch event trace when an event is selected
  const { data: traceData, isLoading: isLoadingTrace } = trpc.system.getEventTrace.useQuery(
    { eventId: selectedEventId! },
    {
      enabled: !!selectedEventId,
    }
  );

  // Update search when URL params change
  useEffect(() => {
    const userId = searchParams.get('userId');
    const eventId = searchParams.get('eventId');
    if (userId || eventId) {
      setSearchTerm(userId || eventId || '');
      if (eventId) {
        setSelectedEventId(eventId);
      }
    }
  }, [searchParams]);

  const handleSearch = () => {
    refetchEvents();
  };

  const handleEventClick = (eventId: string) => {
    setSelectedEventId(eventId);
  };

  return (
    <div style={{ width: '100%', padding: spacing[8] }}>
      <Stack gap={spacing[8]}>
        {/* Header */}
        <div>
          <Title
            order={1}
            style={{
              fontFamily: typography.fontFamily.sans,
              color: colors.text.primary,
            }}
          >
            Investigate
          </Title>
          <Text
            size="sm"
            style={{
              color: colors.text.secondary,
              fontFamily: typography.fontFamily.sans,
            }}
          >
            Incident Investigation & Event Tracing
          </Text>
        </div>

        {/* Search Controls */}
        <Card
          padding={spacing[4]}
          radius={borderRadius.lg}
          style={{
            border: `1px solid ${colors.border.default}`,
            backgroundColor: colors.background.primary,
          }}
        >
          <Group gap={spacing[3]} align="flex-end">
            <TextInput
              label="Search Events"
              placeholder="Enter user ID, event ID, or search term..."
              leftSection={<IconSearch size={16} />}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              style={{ flex: 1 }}
            />
            <Select
              label="Event Type"
              placeholder="All types"
              leftSection={<IconFilter size={16} />}
              data={[
                { value: 'USER_CREATED', label: 'User Created' },
                { value: 'USER_UPDATED', label: 'User Updated' },
                { value: 'NOTE_CREATED', label: 'Note Created' },
                { value: 'NOTE_UPDATED', label: 'Note Updated' },
                { value: 'AI_CONVERSATION_MESSAGE', label: 'AI Message' },
                { value: 'TOOL_EXECUTED', label: 'Tool Executed' },
              ]}
              value={eventTypeFilter}
              onChange={(value) => setEventTypeFilter(value)}
              clearable
              style={{ width: '200px' }}
            />
            <Button onClick={handleSearch} loading={isLoading}>
              Search
            </Button>
          </Group>
        </Card>

        {/* Results */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: spacing[4] }}>
          <Card
            padding={spacing[4]}
            radius={borderRadius.lg}
            style={{
              border: `1px solid ${colors.border.default}`,
              backgroundColor: colors.background.primary,
            }}
          >
            <Group justify="space-between" mb={spacing[4]}>
              <Text size="lg" fw={typography.fontWeight.semibold} c={colors.text.primary}>
                Search Results
              </Text>
              <Badge variant="light" color="gray">
                {events?.length || 0} events
              </Badge>
            </Group>

            <ScrollArea style={{ height: '600px' }}>
              <Stack gap={spacing[2]}>
                {isLoading ? (
                  <SearchResultsSkeleton count={8} />
                ) : !events || events.length === 0 ? (
                  <Text size="sm" c={colors.text.tertiary} ta="center" p={spacing[6]}>
                    No events found. Try adjusting your search criteria.
                  </Text>
                ) : (
                  events.map((event) => (
                    <div
                      key={event.id}
                      onClick={() => handleEventClick(event.id)}
                      style={{
                        padding: spacing[3],
                        borderRadius: borderRadius.base,
                        border: `1px solid ${
                          selectedEventId === event.id
                            ? colors.border.interactive
                            : colors.border.light
                        }`,
                        backgroundColor:
                          selectedEventId === event.id
                            ? '#EFF6FF'
                            : colors.background.secondary,
                        cursor: 'pointer',
                        transition: 'all 0.1s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (selectedEventId !== event.id) {
                          e.currentTarget.style.backgroundColor = colors.background.hover;
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (selectedEventId !== event.id) {
                          e.currentTarget.style.backgroundColor = colors.background.secondary;
                        }
                      }}
                    >
                      <Group justify="space-between" mb={spacing[1]}>
                        <Badge
                          variant="light"
                          color="blue"
                          size="sm"
                          style={{ fontFamily: typography.fontFamily.mono }}
                        >
                          {event.type}
                        </Badge>
                        <Text
                          size="xs"
                          c={colors.text.tertiary}
                          style={{ fontFamily: typography.fontFamily.mono }}
                        >
                          {new Date(event.timestamp).toLocaleString()}
                        </Text>
                      </Group>
                      <Text
                        size="xs"
                        c={colors.text.primary}
                        style={{ fontFamily: typography.fontFamily.mono }}
                      >
                        ID: {event.id}
                      </Text>
                      {event.userId && (
                        <Text size="xs" c={colors.text.secondary} mt={2}>
                          User: {event.userId}
                        </Text>
                      )}
                    </div>
                  ))
                )}
              </Stack>
            </ScrollArea>
          </Card>
        </div>
      </Stack>

      {/* Event Details Drawer */}
      <Drawer
        opened={!!selectedEventId}
        onClose={() => setSelectedEventId(null)}
        position="right"
        size="xl"
        title={
          <Text size="lg" fw={typography.fontWeight.semibold}>
            Event Details & Trace
          </Text>
        }
      >
        {isLoadingTrace ? (
          <Stack gap={spacing[4]}>
            <Skeleton height={200} />
            <Skeleton height={100} />
            <Skeleton height={150} />
          </Stack>
        ) : traceData ? (
          <Stack gap={spacing[6]}>
            {/* Main Event Details */}
            <div>
              <Text size="sm" fw={typography.fontWeight.semibold} mb={spacing[2]}>
                Main Event
              </Text>
              <Card padding={spacing[3]} style={{ backgroundColor: colors.background.secondary }}>
                <Stack gap={spacing[2]}>
                  <Group gap={spacing[2]}>
                    <IconTag size={16} color={colors.text.secondary} />
                    <Text size="sm" fw={typography.fontWeight.medium}>
                      {traceData.event.eventType}
                    </Text>
                  </Group>
                  <Group gap={spacing[2]}>
                    <IconClock size={16} color={colors.text.secondary} />
                    <Text size="xs" c={colors.text.secondary}>
                      {new Date(traceData.event.timestamp).toLocaleString()}
                    </Text>
                  </Group>
                  {traceData.event.userId && (
                    <Group gap={spacing[2]}>
                      <IconUser size={16} color={colors.text.secondary} />
                      <Text size="xs" c={colors.text.secondary}>
                        {traceData.event.userId}
                      </Text>
                    </Group>
                  )}
                  <Group gap={spacing[2]}>
                    <IconCode size={16} color={colors.text.secondary} />
                    <Text size="xs" c={colors.text.secondary} style={{ fontFamily: typography.fontFamily.mono }}>
                      {traceData.event.eventId}
                    </Text>
                  </Group>
                </Stack>
              </Card>
            </div>

            <Divider />

            {/* Event Data */}
            <div>
              <Text size="sm" fw={typography.fontWeight.semibold} mb={spacing[2]}>
                Event Data
              </Text>
              <ScrollArea style={{ maxHeight: '200px' }}>
                <Code block style={{ fontSize: typography.fontSize.xs }}>
                  {JSON.stringify(traceData.event.data, null, 2)}
                </Code>
              </ScrollArea>
            </div>

            <Divider />

            {/* Related Events Timeline */}
            {traceData.relatedEvents && traceData.relatedEvents.length > 0 && (
              <div>
                <Group justify="space-between" mb={spacing[3]}>
                  <Text size="sm" fw={typography.fontWeight.semibold}>
                    Related Events
                  </Text>
                  <Badge variant="light" color="blue">
                    {traceData.relatedEvents.length}
                  </Badge>
                </Group>
                <Timeline active={-1} bulletSize={24} lineWidth={2}>
                  {traceData.relatedEvents.map((relEvent) => (
                    <Timeline.Item
                      key={relEvent.eventId}
                      bullet={<IconTimeline size={12} />}
                      title={
                        <Text size="sm" fw={typography.fontWeight.medium}>
                          {relEvent.eventType}
                        </Text>
                      }
                    >
                      <Text size="xs" c={colors.text.secondary} mt={4}>
                        {new Date(relEvent.timestamp).toLocaleString()}
                      </Text>
                      <Text
                        size="xs"
                        c={colors.text.tertiary}
                        mt={2}
                        style={{ fontFamily: typography.fontFamily.mono }}
                      >
                        {relEvent.eventId}
                      </Text>
                      <Button
                        variant="subtle"
                        size="xs"
                        leftSection={<IconArrowRight size={12} />}
                        onClick={() => handleEventClick(relEvent.eventId)}
                        mt={spacing[2]}
                        aria-label={`View details for event ${relEvent.eventId}`}
                      >
                        View details
                      </Button>
                    </Timeline.Item>
                  ))}
                </Timeline>
              </div>
            )}
          </Stack>
        ) : null}
      </Drawer>
    </div>
  );
}

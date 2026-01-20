import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
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
  Tabs,
  SimpleGrid,
  ThemeIcon,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconSearch,
  IconFilter,
  IconTimeline,
  IconArrowRight,
  IconClock,
  IconUser,
  IconTag,
  IconCode,
  IconRefresh,
  IconBolt,
  IconSend,
  IconList,
  IconDatabase,
  IconPlus,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
import { colors, typography, spacing, borderRadius } from "../../theme/tokens";
import { AdminSDK } from "../../lib/sdk";
import { SearchResultsSkeleton } from "../../components/loading/LoadingSkeletons";
import { trpc } from "../../lib/trpc";
import EventTypeExplorer from "../../components/events/EventTypeExplorer";
import SchemaFormGenerator from "../../components/forms/SchemaFormGenerator";

export default function InvestigatePage() {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<string | null>("search");
  const [searchTerm, setSearchTerm] = useState(
    searchParams.get("userId") || searchParams.get("eventId") || ""
  );
  const [eventTypeFilter, setEventTypeFilter] = useState<string | null>(
    searchParams.get("eventType")
  );
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedEventType, setSelectedEventType] = useState<string | null>(
    null
  );

  // Publish state
  const [publishEventType, setPublishEventType] = useState<string>("");
  const [publishData, setPublishData] = useState<Record<string, unknown>>({});
  const [publishUserId, setPublishUserId] = useState("test-user");

  // Fetch capabilities for event types
  const { data: capabilities } = trpc.system.getCapabilities.useQuery();

  // Fetch schema for publish form
  const { data: publishSchema } = trpc.system.getEventTypeSchema.useQuery(
    { eventType: publishEventType },
    { enabled: !!publishEventType }
  );

  // Fetch events via AdminSDK
  const {
    data,
    refetch: refetchEvents,
    isLoading,
  } = useQuery({
    queryKey: ["events", "search", searchTerm, eventTypeFilter],
    queryFn: () =>
      AdminSDK.events.search({
        limit: 50,
        userId:
          searchTerm && !searchTerm.match(/^[0-9a-f-]{36}$/i)
            ? searchTerm
            : undefined,
        eventType: eventTypeFilter || undefined,
      }),
  });

  const events = data?.events;

  // Fetch trace via AdminSDK
  const { data: traceData, isLoading: isLoadingTrace } = useQuery({
    queryKey: ["events", "trace", selectedEventId],
    queryFn: () => AdminSDK.events.getDetails(selectedEventId!),
    enabled: !!selectedEventId,
  });

  // Republish functionality
  const republishMutation = useMutation({
    mutationFn: async (event: any) => {
      return AdminSDK.events.publish({
        type: event.eventType,
        data: event.data,
        userId: event.userId,
        source: "system",
      });
    },
    onSuccess: () => {
      notifications.show({
        title: "Event Republished",
        message: "The event has been successfully republished.",
        color: "green",
      });
      refetchEvents();
    },
    onError: (err) => {
      notifications.show({
        title: "Republish Failed",
        message: err.message,
        color: "red",
      });
    },
  });

  // Publish new event
  const publishMutation = trpc.system.publishEvent.useMutation({
    onSuccess: (data) => {
      notifications.show({
        title: "Event Published",
        message: `Event ID: ${(data as any).eventId}`,
        color: "green",
      });
      setPublishData({});
    },
    onError: (err) => {
      notifications.show({
        title: "Publish Failed",
        message: err.message,
        color: "red",
      });
    },
  });

  // Update search when URL params change
  useEffect(() => {
    const userId = searchParams.get("userId");
    const eventId = searchParams.get("eventId");
    if (userId || eventId) {
      setSearchTerm(userId || eventId || "");
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

  const handleRepublish = () => {
    if (!traceData?.event) return;
    republishMutation.mutate(traceData.event);
  };

  const handlePublish = () => {
    if (!publishEventType) return;
    publishMutation.mutate({
      type: publishEventType,
      data: publishData,
      userId: publishUserId || "test-user",
    });
  };

  return (
    <div style={{ width: "100%", padding: spacing[8] }}>
      <Stack gap={spacing[6]}>
        {/* Header */}
        <div>
          <Title
            order={1}
            style={{
              fontFamily: typography.fontFamily.sans,
              color: colors.text.primary,
            }}
          >
            Events
          </Title>
          <Text
            size="sm"
            style={{
              color: colors.text.secondary,
              fontFamily: typography.fontFamily.sans,
            }}
          >
            Search, explore, and publish events
          </Text>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="search" leftSection={<IconSearch size={16} />}>
              Search Events
            </Tabs.Tab>
            <Tabs.Tab value="types" leftSection={<IconList size={16} />}>
              Event Types
            </Tabs.Tab>
            <Tabs.Tab value="publish" leftSection={<IconSend size={16} />}>
              Publish Event
            </Tabs.Tab>
          </Tabs.List>

          {/* Search Events Tab */}
          <Tabs.Panel value="search" pt="md">
            <Stack gap="md">
              {/* Search Controls */}
              <Card
                padding="md"
                radius={borderRadius.lg}
                style={{ border: `1px solid ${colors.border.default}` }}
              >
                <Group gap="sm" align="flex-end">
                  <TextInput
                    label="Search Events"
                    placeholder="Enter user ID, event ID, or search term..."
                    leftSection={<IconSearch size={16} />}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    style={{ flex: 1 }}
                  />
                  <Select
                    label="Event Type"
                    placeholder="All types"
                    leftSection={<IconFilter size={16} />}
                    data={
                      capabilities?.eventTypes?.map((et: any) => ({
                        value: et.type,
                        label: et.type,
                      })) || []
                    }
                    value={eventTypeFilter}
                    onChange={(value) => setEventTypeFilter(value)}
                    clearable
                    searchable
                    style={{ width: "250px" }}
                  />
                  <Button onClick={handleSearch} loading={isLoading}>
                    Search
                  </Button>
                </Group>
              </Card>

              {/* Results */}
              <Card
                padding="md"
                radius={borderRadius.lg}
                style={{ border: `1px solid ${colors.border.default}` }}
              >
                <Group justify="space-between" mb="md">
                  <Text size="lg" fw={600}>
                    Search Results
                  </Text>
                  <Badge variant="light" color="gray">
                    {events?.length || 0} events
                  </Badge>
                </Group>

                <ScrollArea style={{ height: "500px" }}>
                  <Stack gap="xs">
                    {isLoading ? (
                      <SearchResultsSkeleton count={8} />
                    ) : !events || events.length === 0 ? (
                      <Text size="sm" c="dimmed" ta="center" py="xl">
                        No events found
                      </Text>
                    ) : (
                      events.map((event) => (
                        <div
                          key={event.id}
                          onClick={() => handleEventClick(event.id)}
                          style={{
                            padding: spacing[3],
                            borderRadius: borderRadius.base,
                            border: `1px solid ${selectedEventId === event.id ? colors.border.interactive : colors.border.light}`,
                            backgroundColor:
                              selectedEventId === event.id
                                ? "#EFF6FF"
                                : colors.background.secondary,
                            cursor: "pointer",
                          }}
                        >
                          <Group justify="space-between" mb={4}>
                            <Badge variant="light" color="blue" size="sm">
                              {event.type}
                            </Badge>
                            <Text size="xs" c="dimmed">
                              {new Date(event.timestamp).toLocaleString()}
                            </Text>
                          </Group>
                          <Text
                            size="xs"
                            style={{ fontFamily: typography.fontFamily.mono }}
                          >
                            ID: {event.id}
                          </Text>
                          {event.userId && (
                            <Text size="xs" c="dimmed">
                              User: {event.userId}
                            </Text>
                          )}
                        </div>
                      ))
                    )}
                  </Stack>
                </ScrollArea>
              </Card>
            </Stack>
          </Tabs.Panel>

          {/* Event Types Tab */}
          <Tabs.Panel value="types" pt="md">
            {selectedEventType ? (
              <EventTypeExplorer
                eventType={selectedEventType}
                onClose={() => setSelectedEventType(null)}
              />
            ) : (
              <Stack gap="md">
                <Card
                  padding="md"
                  radius={borderRadius.lg}
                  style={{ border: `1px solid ${colors.border.default}` }}
                >
                  <Text size="lg" fw={600} mb="md">
                    Event Types ({capabilities?.eventTypes?.length || 0})
                  </Text>
                  <Text size="sm" c="dimmed" mb="md">
                    Pattern: table.action.modifier
                  </Text>
                </Card>

                {/* Group events by table */}
                {(() => {
                  const eventTypes = capabilities?.eventTypes || [];
                  // Group by first segment (table name)
                  const grouped = eventTypes.reduce(
                    (acc: Record<string, any[]>, et: any) => {
                      const parts = et.type.split(".");
                      const table = parts[0];
                      if (!acc[table]) acc[table] = [];
                      acc[table].push({
                        ...et,
                        action: parts[1] || "",
                        modifier: parts[2] || "",
                        fullAction: parts.slice(1).join("."),
                      });
                      return acc;
                    },
                    {}
                  );

                  // Sort tables and render
                  return Object.entries(grouped)
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([table, events]: [string, any[]]) => {
                      // Group by action within table
                      const byAction = events.reduce(
                        (acc: Record<string, any[]>, e: any) => {
                          const action = e.action || "other";
                          if (!acc[action]) acc[action] = [];
                          acc[action].push(e);
                          return acc;
                        },
                        {}
                      );

                      return (
                        <Card
                          key={table}
                          padding="md"
                          radius={borderRadius.lg}
                          style={{
                            border: `1px solid ${colors.border.default}`,
                          }}
                        >
                          {/* Table Header */}
                          <Group gap="sm" mb="md">
                            <ThemeIcon
                              size={40}
                              radius="md"
                              color="blue"
                              variant="light"
                            >
                              <IconDatabase size={24} />
                            </ThemeIcon>
                            <div>
                              <Text size="lg" fw={600}>
                                {table}
                              </Text>
                              <Text size="sm" c="dimmed">
                                {events.length} event types
                              </Text>
                            </div>
                          </Group>

                          {/* Actions Grid */}
                          <SimpleGrid
                            cols={{ base: 1, sm: 2, md: 3 }}
                            spacing="sm"
                          >
                            {Object.entries(byAction)
                              .sort((a, b) => a[0].localeCompare(b[0]))
                              .map(
                                ([action, actionEvents]: [string, any[]]) => {
                                  // Get modifiers for this action
                                  const modifiers = actionEvents
                                    .map((e) => e.modifier)
                                    .filter(Boolean);
                                  const hasModifiers = modifiers.length > 0;

                                  return (
                                    <Card
                                      key={`${table}.${action}`}
                                      padding="sm"
                                      radius="md"
                                      style={{
                                        background: colors.background.secondary,
                                        border: `1px solid ${colors.border.light}`,
                                      }}
                                    >
                                      {/* Action Header */}
                                      <Group
                                        gap="xs"
                                        mb={hasModifiers ? "xs" : 0}
                                      >
                                        <ThemeIcon
                                          size={28}
                                          radius="sm"
                                          color={
                                            action === "create"
                                              ? "green"
                                              : action === "update"
                                                ? "orange"
                                                : action === "delete"
                                                  ? "red"
                                                  : "gray"
                                          }
                                          variant="light"
                                        >
                                          {action === "create" && (
                                            <IconPlus size={16} />
                                          )}
                                          {action === "update" && (
                                            <IconPencil size={16} />
                                          )}
                                          {action === "delete" && (
                                            <IconTrash size={16} />
                                          )}
                                          {![
                                            "create",
                                            "update",
                                            "delete",
                                          ].includes(action) && (
                                            <IconBolt size={16} />
                                          )}
                                        </ThemeIcon>
                                        <Text size="sm" fw={500}>
                                          {action}
                                        </Text>
                                      </Group>

                                      {/* Modifiers */}
                                      {hasModifiers && (
                                        <Stack gap={4} ml={36}>
                                          {actionEvents.map((e: any) => (
                                            <Group
                                              key={e.type}
                                              gap="xs"
                                              style={{ cursor: "pointer" }}
                                              onClick={() =>
                                                setSelectedEventType(e.type)
                                              }
                                            >
                                              <Text size="xs" c="dimmed">
                                                →
                                              </Text>
                                              <Badge
                                                size="xs"
                                                variant="dot"
                                                color={
                                                  e.modifier === "requested"
                                                    ? "blue"
                                                    : e.modifier === "completed"
                                                      ? "green"
                                                      : "gray"
                                                }
                                              >
                                                {e.modifier || action}
                                              </Badge>
                                              {e.hasSchema && (
                                                <Badge
                                                  size="xs"
                                                  color="violet"
                                                  variant="light"
                                                >
                                                  Schema
                                                </Badge>
                                              )}
                                            </Group>
                                          ))}
                                        </Stack>
                                      )}

                                      {/* If no modifiers, make the whole card clickable */}
                                      {!hasModifiers && (
                                        <div
                                          style={{
                                            cursor: "pointer",
                                            marginTop: 4,
                                          }}
                                          onClick={() =>
                                            setSelectedEventType(
                                              actionEvents[0]?.type
                                            )
                                          }
                                        >
                                          <Text size="xs" c="dimmed">
                                            {actionEvents[0]?.type}
                                          </Text>
                                        </div>
                                      )}
                                    </Card>
                                  );
                                }
                              )}
                          </SimpleGrid>
                        </Card>
                      );
                    });
                })()}
              </Stack>
            )}
          </Tabs.Panel>

          {/* Publish Event Tab */}
          <Tabs.Panel value="publish" pt="md">
            <Card
              padding="md"
              radius={borderRadius.lg}
              style={{ border: `1px solid ${colors.border.default}` }}
            >
              <Text size="lg" fw={600} mb="md">
                Publish Test Event
              </Text>
              <Stack gap="md">
                <Select
                  label="Event Type"
                  placeholder="Select event type"
                  data={
                    capabilities?.eventTypes?.map((et: any) => ({
                      value: et.type,
                      label: et.type,
                    })) || []
                  }
                  value={publishEventType}
                  onChange={(value) => setPublishEventType(value || "")}
                  searchable
                  required
                />

                <TextInput
                  label="User ID"
                  placeholder="test-user"
                  value={publishUserId}
                  onChange={(e) => setPublishUserId(e.target.value)}
                />

                {publishEventType && publishSchema?.hasSchema && (
                  <SchemaFormGenerator
                    eventType={publishEventType}
                    value={publishData}
                    onChange={setPublishData}
                    errors={{}}
                  />
                )}

                <Button
                  leftSection={<IconSend size={16} />}
                  onClick={handlePublish}
                  loading={publishMutation.isPending}
                  disabled={!publishEventType}
                  fullWidth
                >
                  Publish Event
                </Button>
              </Stack>
            </Card>
          </Tabs.Panel>
        </Tabs>
      </Stack>

      {/* Event Details Drawer */}
      <Drawer
        opened={!!selectedEventId}
        onClose={() => setSelectedEventId(null)}
        position="right"
        size="xl"
        title={
          <Group justify="space-between" style={{ width: "100%" }}>
            <Text size="lg" fw={600}>
              Event Details & Trace
            </Text>
            {traceData?.event && (
              <Button
                variant="light"
                color="orange"
                size="xs"
                leftSection={<IconRefresh size={14} />}
                loading={republishMutation.isPending}
                onClick={handleRepublish}
              >
                Republish Event
              </Button>
            )}
          </Group>
        }
      >
        {isLoadingTrace ? (
          <Stack gap="md">
            <Skeleton height={200} />
            <Skeleton height={100} />
            <Skeleton height={150} />
          </Stack>
        ) : traceData ? (
          <Stack gap="lg">
            {/* Main Event Details */}
            <div>
              <Text size="sm" fw={600} mb="sm">
                Main Event
              </Text>
              <Card
                padding="sm"
                style={{ backgroundColor: colors.background.secondary }}
              >
                <Stack gap="xs">
                  <Group gap="xs">
                    <IconTag size={16} color={colors.text.secondary} />
                    <Text size="sm" fw={500}>
                      {traceData.event.eventType}
                    </Text>
                  </Group>
                  <Group gap="xs">
                    <IconClock size={16} color={colors.text.secondary} />
                    <Text size="xs" c="dimmed">
                      {new Date(traceData.event.timestamp).toLocaleString()}
                    </Text>
                  </Group>
                  {traceData.event.userId && (
                    <Group gap="xs">
                      <IconUser size={16} color={colors.text.secondary} />
                      <Text size="xs" c="dimmed">
                        {traceData.event.userId}
                      </Text>
                    </Group>
                  )}
                  <Group gap="xs">
                    <IconCode size={16} color={colors.text.secondary} />
                    <Text
                      size="xs"
                      c="dimmed"
                      style={{ fontFamily: typography.fontFamily.mono }}
                    >
                      {traceData.event.eventId}
                    </Text>
                  </Group>
                </Stack>
              </Card>
            </div>

            <Divider />

            {/* Event Data */}
            <div>
              <Text size="sm" fw={600} mb="sm">
                Event Data
              </Text>
              <ScrollArea style={{ maxHeight: "200px" }}>
                <Code block style={{ fontSize: typography.fontSize.xs }}>
                  {JSON.stringify(traceData.event.data, null, 2)}
                </Code>
              </ScrollArea>
            </div>

            <Divider />

            {/* Related Events Timeline */}
            {traceData.relatedEvents && traceData.relatedEvents.length > 0 && (
              <div>
                <Group justify="space-between" mb="sm">
                  <Text size="sm" fw={600}>
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
                        <Text size="sm" fw={500}>
                          {relEvent.eventType}
                        </Text>
                      }
                    >
                      <Text size="xs" c="dimmed" mt={4}>
                        {new Date(relEvent.timestamp).toLocaleString()}
                      </Text>
                      <Text
                        size="xs"
                        c="gray"
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
                        mt="xs"
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

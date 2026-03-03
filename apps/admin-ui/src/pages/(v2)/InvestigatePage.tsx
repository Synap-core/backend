import { useState, useEffect, useDeferredValue } from "react";
import { useSearchParams } from "react-router-dom";
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
  Collapse,
  ActionIcon,
  Tooltip,
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
  IconChevronDown,
  IconChevronRight,
  IconX,
} from "@tabler/icons-react";
import { colors, typography, spacing, borderRadius } from "../../theme/tokens";
import { SearchResultsSkeleton } from "../../components/loading/LoadingSkeletons";
import { trpc } from "../../lib/trpc";
import EventTypeExplorer from "../../components/events/EventTypeExplorer";
import SchemaFormGenerator from "../../components/forms/SchemaFormGenerator";

export default function InvestigatePage() {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<string | null>("search");

  // Search state
  const [searchTerm, setSearchTerm] = useState(
    searchParams.get("userId") || searchParams.get("eventId") || ""
  );
  const [eventTypeFilter, setEventTypeFilter] = useState<string | null>(
    searchParams.get("eventType")
  );
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  // Deferred values for live filtering (avoids layout jank)
  const deferredSearch = useDeferredValue(searchTerm);
  const deferredEventType = useDeferredValue(eventTypeFilter);

  // Event details state
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedEventType, setSelectedEventType] = useState<string | null>(null);

  // Event Types tab search
  const [typesSearch, setTypesSearch] = useState("");
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

  // Publish state
  const [publishEventType, setPublishEventType] = useState<string>("");
  const [publishData, setPublishData] = useState<Record<string, unknown>>({});
  const [publishUserId, setPublishUserId] = useState("test-user");

  // ── Data fetching via tRPC ──────────────────────────────────────────────

  // Fetch system capabilities (event types list)
  const { data: capabilities } = trpc.system.getCapabilities.useQuery();

  // Fetch schema for publish form
  const { data: publishSchema } = trpc.system.getEventTypeSchema.useQuery(
    { eventType: publishEventType },
    { enabled: !!publishEventType }
  );

  // Convert datetime-local value (no tz) to ISO 8601 with timezone
  const toIso = (v: string) => (v ? new Date(v).toISOString() : undefined);

  // Build search filters from current state
  const buildFilters = () => {
    const isUuid = /^[0-9a-f-]{36}$/i.test(deferredSearch);
    return {
      userId: deferredSearch && !isUuid ? deferredSearch : undefined,
      correlationId: deferredSearch && isUuid ? deferredSearch : undefined,
      eventType: deferredEventType || undefined,
      fromDate: toIso(fromDate),
      toDate: toIso(toDate),
      limit: 100,
    };
  };

  // Search events — always enabled, refetches when filters change
  const {
    data: searchData,
    isLoading: isLoadingSearch,
    isFetching: isFetchingSearch,
    refetch: refetchSearch,
  } = trpc.system.searchEvents.useQuery(buildFilters(), {
    refetchOnWindowFocus: false,
  });

  const events = searchData?.events ?? [];

  // Fetch trace when an event is selected
  const { data: traceData, isLoading: isLoadingTrace } =
    trpc.system.getEventTrace.useQuery(
      { eventId: selectedEventId! },
      { enabled: !!selectedEventId }
    );

  // Republish mutation
  const republishMutation = trpc.system.publishEvent.useMutation({
    onSuccess: () => {
      notifications.show({
        title: "Event Republished",
        message: "The event has been successfully republished.",
        color: "green",
      });
      refetchSearch();
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
      refetchSearch();
    },
    onError: (err) => {
      notifications.show({
        title: "Publish Failed",
        message: err.message,
        color: "red",
      });
    },
  });

  // Update search when URL params change (e.g. navigated from Dashboard)
  useEffect(() => {
    const userId = searchParams.get("userId");
    const eventId = searchParams.get("eventId");
    const eventType = searchParams.get("eventType");
    if (userId) setSearchTerm(userId);
    if (eventId) {
      setSearchTerm(eventId);
      setSelectedEventId(eventId);
    }
    if (eventType) setEventTypeFilter(eventType);
  }, [searchParams]);

  const handleEventClick = (eventId: string) => {
    setSelectedEventId(eventId);
  };

  const handleRepublish = () => {
    if (!traceData?.event) return;
    republishMutation.mutate({
      type: traceData.event.eventType,
      data: (traceData.event.data as Record<string, unknown>) ?? {},
      userId: traceData.event.userId ?? "admin-ui",
    });
  };

  const handlePublish = () => {
    if (!publishEventType) return;
    publishMutation.mutate({
      type: publishEventType,
      data: publishData,
      userId: publishUserId || "test-user",
    });
  };

  const clearFilters = () => {
    setSearchTerm("");
    setEventTypeFilter(null);
    setFromDate("");
    setToDate("");
  };

  const hasActiveFilters = !!(searchTerm || eventTypeFilter || fromDate || toDate);

  // ── Event Types tab helpers ─────────────────────────────────────────────

  const toggleTable = (table: string) => {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  };

  const actionColor = (action: string) =>
    action === "create"
      ? "green"
      : action === "update" || action === "add"
      ? "orange"
      : action === "delete" || action === "remove"
      ? "red"
      : "gray";

  const actionIcon = (action: string) => {
    if (action === "create" || action === "add") return <IconPlus size={14} />;
    if (action === "update") return <IconPencil size={14} />;
    if (action === "delete" || action === "remove") return <IconTrash size={14} />;
    return <IconBolt size={14} />;
  };

  // Filter + group event types for the Event Types tab
  const filteredGrouped = (() => {
    const allTypes = capabilities?.eventTypes ?? [];
    const q = typesSearch.toLowerCase();
    const filtered = q
      ? allTypes.filter((et: any) => et.type.toLowerCase().includes(q))
      : allTypes;

    const grouped = filtered.reduce((acc: Record<string, any[]>, et: any) => {
      const parts = et.type.split(".");
      const table = parts[0];
      if (!acc[table]) acc[table] = [];
      acc[table].push({
        ...et,
        action: parts[1] || "",
        modifier: parts[2] || "",
      });
      return acc;
    }, {});

    return Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]));
  })();

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div style={{ width: "100%", padding: spacing[8] }}>
      <Stack gap={spacing[6]}>
        {/* Header */}
        <div>
          <Title
            order={1}
            style={{ fontFamily: typography.fontFamily.sans, color: colors.text.primary }}
          >
            Events
          </Title>
          <Text size="sm" style={{ color: colors.text.secondary, fontFamily: typography.fontFamily.sans }}>
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
              {capabilities?.eventTypes && (
                <Badge size="xs" variant="light" color="gray" ml={6}>
                  {capabilities.eventTypes.length}
                </Badge>
              )}
            </Tabs.Tab>
            <Tabs.Tab value="publish" leftSection={<IconSend size={16} />}>
              Publish Event
            </Tabs.Tab>
          </Tabs.List>

          {/* ── Search Events Tab ── */}
          <Tabs.Panel value="search" pt="md">
            <Stack gap="md">
              {/* Filters Bar */}
              <Card
                padding="md"
                radius={borderRadius.lg}
                style={{ border: `1px solid ${colors.border.default}` }}
              >
                <Group gap="sm" align="flex-end" wrap="nowrap">
                  <TextInput
                    placeholder="Filter by user ID, UUID (correlation), or leave empty to see all…"
                    leftSection={<IconSearch size={16} />}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    style={{ flex: 1 }}
                    rightSection={
                      searchTerm ? (
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          onClick={() => setSearchTerm("")}
                        >
                          <IconX size={14} />
                        </ActionIcon>
                      ) : null
                    }
                  />
                  <Select
                    placeholder="All types"
                    leftSection={<IconFilter size={14} />}
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
                    style={{ width: "220px" }}
                  />
                  <Tooltip label="Advanced filters">
                    <ActionIcon
                      variant={showAdvancedFilters ? "filled" : "subtle"}
                      color={showAdvancedFilters ? "blue" : "gray"}
                      onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
                    >
                      <IconFilter size={16} />
                    </ActionIcon>
                  </Tooltip>
                  {hasActiveFilters && (
                    <Button variant="subtle" color="gray" size="sm" onClick={clearFilters}>
                      Clear
                    </Button>
                  )}
                </Group>

                <Collapse in={showAdvancedFilters}>
                  <Group gap="sm" mt="sm">
                    <TextInput
                      label="From"
                      type="datetime-local"
                      value={fromDate}
                      onChange={(e) => setFromDate(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <TextInput
                      label="To"
                      type="datetime-local"
                      value={toDate}
                      onChange={(e) => setToDate(e.target.value)}
                      style={{ flex: 1 }}
                    />
                  </Group>
                </Collapse>
              </Card>

              {/* Results */}
              <Card
                padding="md"
                radius={borderRadius.lg}
                style={{ border: `1px solid ${colors.border.default}` }}
              >
                <Group justify="space-between" mb="md">
                  <Group gap="xs">
                    <Text size="lg" fw={600}>
                      {hasActiveFilters ? "Filtered Results" : "Recent Events"}
                    </Text>
                    {isFetchingSearch && !isLoadingSearch && (
                      <Text size="xs" c="dimmed">updating…</Text>
                    )}
                  </Group>
                  <Group gap="xs">
                    <Badge variant="light" color="gray">
                      {events.length} events
                    </Badge>
                    <ActionIcon variant="subtle" onClick={() => refetchSearch()}>
                      <IconRefresh size={16} />
                    </ActionIcon>
                  </Group>
                </Group>

                <ScrollArea style={{ height: "520px" }}>
                  <Stack gap="xs">
                    {isLoadingSearch ? (
                      <SearchResultsSkeleton count={8} />
                    ) : events.length === 0 ? (
                      <Stack align="center" py="xl" gap="xs">
                        <Text size="sm" c="dimmed">
                          {hasActiveFilters
                            ? "No events match the current filters."
                            : "No events recorded yet."}
                        </Text>
                        {hasActiveFilters && (
                          <Button variant="subtle" size="xs" onClick={clearFilters}>
                            Clear filters
                          </Button>
                        )}
                      </Stack>
                    ) : (
                      events.map((event) => (
                        <div
                          key={event.id}
                          onClick={() => handleEventClick(event.id)}
                          style={{
                            padding: `${spacing[2]} ${spacing[3]}`,
                            borderRadius: borderRadius.base,
                            border: `1px solid ${
                              selectedEventId === event.id
                                ? colors.border.interactive
                                : colors.border.light
                            }`,
                            backgroundColor:
                              selectedEventId === event.id
                                ? "#EFF6FF"
                                : colors.background.secondary,
                            cursor: "pointer",
                            transition: "background-color 0.1s ease",
                          }}
                        >
                          <Group justify="space-between" gap="xs">
                            <Group gap="xs" style={{ flex: 1, minWidth: 0 }}>
                              <Badge
                                variant="light"
                                color={
                                  (event.type ?? "").includes("error") ||
                                  (event.type ?? "").includes("failed")
                                    ? "red"
                                    : "blue"
                                }
                                size="sm"
                                style={{
                                  fontFamily: typography.fontFamily.mono,
                                  flexShrink: 0,
                                }}
                              >
                                {event.type}
                              </Badge>
                              <Text
                                size="xs"
                                c="dimmed"
                                style={{
                                  fontFamily: typography.fontFamily.mono,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {event.id}
                              </Text>
                            </Group>
                            <Group gap="xs" style={{ flexShrink: 0 }}>
                              {event.userId && (
                                <Text size="xs" c="dimmed">
                                  {event.userId.length > 20
                                    ? `${event.userId.slice(0, 8)}…`
                                    : event.userId}
                                </Text>
                              )}
                              <Text size="xs" c="dimmed">
                                {new Date(event.timestamp).toLocaleString()}
                              </Text>
                            </Group>
                          </Group>
                        </div>
                      ))
                    )}
                  </Stack>
                </ScrollArea>
              </Card>
            </Stack>
          </Tabs.Panel>

          {/* ── Event Types Tab ── */}
          <Tabs.Panel value="types" pt="md">
            {selectedEventType ? (
              <EventTypeExplorer
                eventType={selectedEventType}
                onClose={() => setSelectedEventType(null)}
              />
            ) : (
              <Stack gap="md">
                {/* Search bar for types */}
                <Card
                  padding="md"
                  radius={borderRadius.lg}
                  style={{ border: `1px solid ${colors.border.default}` }}
                >
                  <Group gap="sm" justify="space-between">
                    <TextInput
                      placeholder="Filter event types…"
                      leftSection={<IconSearch size={16} />}
                      value={typesSearch}
                      onChange={(e) => setTypesSearch(e.target.value)}
                      rightSection={
                        typesSearch ? (
                          <ActionIcon size="sm" variant="subtle" onClick={() => setTypesSearch("")}>
                            <IconX size={14} />
                          </ActionIcon>
                        ) : null
                      }
                      style={{ flex: 1 }}
                    />
                    <Text size="sm" c="dimmed">
                      {filteredGrouped.length} table{filteredGrouped.length !== 1 ? "s" : ""}
                      {typesSearch && ` matching "${typesSearch}"`}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed" mt="xs">
                    Pattern: <code>table.action.modifier</code> — click a modifier to explore
                  </Text>
                </Card>

                {/* Grouped cards — collapsed by default, expand on click */}
                {filteredGrouped.map(([table, tableEvents]) => {
                  const isOpen = expandedTables.has(table) || !!typesSearch;

                  // Group by action within table
                  const byAction = (tableEvents as any[]).reduce(
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
                      style={{ border: `1px solid ${colors.border.default}` }}
                    >
                      {/* Table header — clickable to expand/collapse */}
                      <Group
                        gap="sm"
                        style={{ cursor: "pointer" }}
                        onClick={() => !typesSearch && toggleTable(table)}
                      >
                        <ThemeIcon size={36} radius="md" color="blue" variant="light">
                          <IconDatabase size={20} />
                        </ThemeIcon>
                        <div style={{ flex: 1 }}>
                          <Text size="md" fw={600}>
                            {table}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {tableEvents.length} event type{tableEvents.length !== 1 ? "s" : ""}
                          </Text>
                        </div>
                        {!typesSearch && (
                          <ActionIcon variant="subtle" color="gray">
                            {isOpen ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
                          </ActionIcon>
                        )}
                      </Group>

                      <Collapse in={isOpen}>
                        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="sm" mt="md">
                          {Object.entries(byAction)
                            .sort((a, b) => a[0].localeCompare(b[0]))
                            .map(([action, actionEvents]: [string, any[]]) => {
                              const modifiers = actionEvents
                                .map((e: any) => e.modifier)
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
                                  <Group gap="xs" mb={hasModifiers ? "xs" : 0}>
                                    <ThemeIcon
                                      size={26}
                                      radius="sm"
                                      color={actionColor(action)}
                                      variant="light"
                                    >
                                      {actionIcon(action)}
                                    </ThemeIcon>
                                    <Text size="sm" fw={500}>
                                      {action}
                                    </Text>
                                  </Group>

                                  {hasModifiers && (
                                    <Stack gap={4} ml={34}>
                                      {actionEvents.map((e: any) => (
                                        <Group
                                          key={e.type}
                                          gap="xs"
                                          style={{ cursor: "pointer" }}
                                          onClick={() => setSelectedEventType(e.type)}
                                        >
                                          <Text size="xs" c="dimmed">→</Text>
                                          <Badge
                                            size="xs"
                                            variant="dot"
                                            color={
                                              e.modifier === "requested"
                                                ? "blue"
                                                : e.modifier === "completed"
                                                ? "green"
                                                : e.modifier === "validated"
                                                ? "teal"
                                                : "gray"
                                            }
                                          >
                                            {e.modifier}
                                          </Badge>
                                          {e.hasSchema && (
                                            <Badge size="xs" color="violet" variant="light">
                                              Schema
                                            </Badge>
                                          )}
                                        </Group>
                                      ))}
                                    </Stack>
                                  )}

                                  {!hasModifiers && (
                                    <div
                                      style={{ cursor: "pointer", marginTop: 4 }}
                                      onClick={() => setSelectedEventType(actionEvents[0]?.type)}
                                    >
                                      <Text size="xs" c="dimmed">{actionEvents[0]?.type}</Text>
                                    </div>
                                  )}
                                </Card>
                              );
                            })}
                        </SimpleGrid>
                      </Collapse>
                    </Card>
                  );
                })}

                {filteredGrouped.length === 0 && (
                  <Text size="sm" c="dimmed" ta="center" py="xl">
                    No event types match "{typesSearch}"
                  </Text>
                )}
              </Stack>
            )}
          </Tabs.Panel>

          {/* ── Publish Event Tab ── */}
          <Tabs.Panel value="publish" pt="md">
            <Card
              padding="md"
              radius={borderRadius.lg}
              style={{ border: `1px solid ${colors.border.default}` }}
            >
              <Text size="lg" fw={600} mb="xs">
                Publish Test Event
              </Text>
              <Text size="sm" c="dimmed" mb="md">
                Inject an event directly into the event store for testing or debugging.
              </Text>
              <Stack gap="md">
                <Select
                  label="Event Type"
                  placeholder="Select or search event type"
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
                  clearable
                />

                <TextInput
                  label="User ID"
                  description="The user to attribute this event to"
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

                {publishEventType && !publishSchema?.hasSchema && (
                  <Text size="xs" c="dimmed">
                    No schema registered for this event type — it will be published with empty data.
                  </Text>
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

      {/* ── Event Details Drawer ── */}
      <Drawer
        opened={!!selectedEventId}
        onClose={() => setSelectedEventId(null)}
        position="right"
        size="xl"
        title={
          <Group gap="sm">
            <IconTimeline size={20} color={colors.semantic.info} />
            <Text size="lg" fw={600}>
              Event Details & Trace
            </Text>
          </Group>
        }
      >
        {/* Republish action in drawer header area */}
        {traceData?.event && (
          <Group mb="md">
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
          </Group>
        )}

        {isLoadingTrace ? (
          <Stack gap="md">
            <Skeleton height={140} radius="md" />
            <Skeleton height={100} radius="md" />
            <Skeleton height={160} radius="md" />
          </Stack>
        ) : traceData ? (
          <Stack gap="lg">
            {/* Main Event */}
            <div>
              <Text size="sm" fw={600} mb="sm">
                Main Event
              </Text>
              <Card padding="sm" style={{ backgroundColor: colors.background.secondary }}>
                <Stack gap="xs">
                  <Group gap="xs">
                    <IconTag size={15} color={colors.text.secondary} />
                    <Badge variant="light" color="blue" style={{ fontFamily: typography.fontFamily.mono }}>
                      {traceData.event.eventType}
                    </Badge>
                  </Group>
                  <Group gap="xs">
                    <IconClock size={15} color={colors.text.secondary} />
                    <Text size="xs" c="dimmed">
                      {new Date(traceData.event.timestamp).toLocaleString()}
                    </Text>
                  </Group>
                  {traceData.event.userId && (
                    <Group gap="xs">
                      <IconUser size={15} color={colors.text.secondary} />
                      <Text size="xs" c="dimmed">
                        {traceData.event.userId}
                      </Text>
                    </Group>
                  )}
                  <Group gap="xs">
                    <IconCode size={15} color={colors.text.secondary} />
                    <Text size="xs" c="dimmed" style={{ fontFamily: typography.fontFamily.mono }}>
                      {traceData.event.eventId}
                    </Text>
                  </Group>
                  {traceData.event.correlationId && (
                    <Group gap="xs">
                      <IconTimeline size={15} color={colors.text.secondary} />
                      <Text size="xs" c="dimmed" style={{ fontFamily: typography.fontFamily.mono }}>
                        corr: {traceData.event.correlationId}
                      </Text>
                    </Group>
                  )}
                </Stack>
              </Card>
            </div>

            <Divider />

            {/* Event Data */}
            <div>
              <Text size="sm" fw={600} mb="sm">
                Event Data
              </Text>
              <ScrollArea style={{ maxHeight: "220px" }}>
                <Code block style={{ fontSize: typography.fontSize.xs }}>
                  {JSON.stringify(traceData.event.data, null, 2)}
                </Code>
              </ScrollArea>
            </div>

            {/* Related Events Timeline */}
            {traceData.relatedEvents && traceData.relatedEvents.length > 0 && (
              <>
                <Divider />
                <div>
                  <Group justify="space-between" mb="sm">
                    <Text size="sm" fw={600}>
                      Correlated Events
                    </Text>
                    <Badge variant="light" color="blue">
                      {traceData.relatedEvents.length}
                    </Badge>
                  </Group>
                  <Timeline active={-1} bulletSize={22} lineWidth={2}>
                    {traceData.relatedEvents.map((relEvent) => (
                      <Timeline.Item
                        key={relEvent.eventId}
                        bullet={<IconTimeline size={11} />}
                        title={
                          <Badge
                            variant="light"
                            color="blue"
                            size="sm"
                            style={{ fontFamily: typography.fontFamily.mono }}
                          >
                            {relEvent.eventType}
                          </Badge>
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
              </>
            )}

            {traceData.relatedEvents?.length === 0 && (
              <Text size="xs" c="dimmed" ta="center">
                No correlated events — this event has no correlation ID.
              </Text>
            )}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed" ta="center" py="xl">
            Event not found.
          </Text>
        )}
      </Drawer>
    </div>
  );
}

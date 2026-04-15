import { useState, useDeferredValue } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Button,
  Card,
  Chip,
  cn,
  Drawer,
  Input,
  Label,
  Separator,
  Skeleton,
  Spinner,
  Tabs,
  Text,
  useOverlayState,
} from "@heroui/react";
import {
  showSuccessNotification,
  showErrorNotification,
} from "../../lib/notifications";
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
import { SearchResultsSkeleton } from "../../components/loading/LoadingSkeletons";
import { trpc } from "../../lib/trpc";
import EventTypeExplorer from "../../components/events/EventTypeExplorer";
import SchemaFormGenerator from "../../components/forms/SchemaFormGenerator";

const inputClass =
  "border-default-200 bg-background text-foreground focus:border-accent w-full rounded-lg border px-3 py-2 text-sm outline-none";

function actionTone(action: string): string {
  if (action === "create" || action === "add")
    return "bg-success/15 text-success";
  if (action === "update") return "bg-warning/15 text-warning";
  if (action === "delete" || action === "remove")
    return "bg-danger/15 text-danger";
  return "bg-default-100 text-default-600";
}

function actionIconNode(action: string) {
  if (action === "create" || action === "add") return <IconPlus size={14} />;
  if (action === "update") return <IconPencil size={14} />;
  if (action === "delete" || action === "remove")
    return <IconTrash size={14} />;
  return <IconBolt size={14} />;
}

type EventTypeEntry = {
  type: string;
  hasSchema: boolean;
  action: string;
  modifier: string;
};

export default function InvestigatePage() {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState("search");

  const [searchTerm, setSearchTerm] = useState(
    searchParams.get("userId") || searchParams.get("eventId") || ""
  );
  const [eventTypeFilter, setEventTypeFilter] = useState<string | null>(
    searchParams.get("eventType")
  );
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const deferredSearch = useDeferredValue(searchTerm);
  const deferredEventType = useDeferredValue(eventTypeFilter);

  const [selectedEventId, setSelectedEventId] = useState<string | null>(() =>
    searchParams.get("eventId")
  );
  const [selectedEventType, setSelectedEventType] = useState<string | null>(
    null
  );

  const [typesSearch, setTypesSearch] = useState("");
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

  const [publishEventType, setPublishEventType] = useState("");
  const [publishData, setPublishData] = useState<Record<string, unknown>>({});
  const [publishUserId, setPublishUserId] = useState("test-user");

  const eventDrawer = useOverlayState({
    isOpen: !!selectedEventId,
    onOpenChange: (open) => {
      if (!open) setSelectedEventId(null);
    },
  });

  const { data: capabilities } = trpc.system.getCapabilities.useQuery();

  const { data: publishSchema } = trpc.system.getEventTypeSchema.useQuery(
    { eventType: publishEventType },
    { enabled: !!publishEventType }
  );

  const toIso = (v: string) => (v ? new Date(v).toISOString() : undefined);

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

  const {
    data: searchData,
    isLoading: isLoadingSearch,
    isFetching: isFetchingSearch,
    refetch: refetchSearch,
  } = trpc.system.searchEvents.useQuery(buildFilters(), {
    refetchOnWindowFocus: false,
  });

  const events = searchData?.events ?? [];

  const { data: traceData, isLoading: isLoadingTrace } =
    trpc.system.getEventTrace.useQuery(
      { eventId: selectedEventId! },
      { enabled: !!selectedEventId }
    );

  const republishMutation = trpc.system.publishEvent.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: "Event Republished",
        message: "The event has been successfully republished.",
      });
      refetchSearch();
    },
    onError: (err) => {
      showErrorNotification({
        title: "Republish Failed",
        message: err.message,
      });
    },
  });

  const publishMutation = trpc.system.publishEvent.useMutation({
    onSuccess: (data) => {
      showSuccessNotification({
        title: "Event Published",
        message: `Event ID: ${(data as { eventId?: string }).eventId ?? ""}`,
      });
      setPublishData({});
      refetchSearch();
    },
    onError: (err) => {
      showErrorNotification({
        title: "Publish Failed",
        message: err.message,
      });
    },
  });

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

  const hasActiveFilters = !!(
    searchTerm ||
    eventTypeFilter ||
    fromDate ||
    toDate
  );

  const toggleTable = (table: string) => {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  };

  const filteredGrouped = (() => {
    const allTypes = capabilities?.eventTypes ?? [];
    const q = typesSearch.toLowerCase();
    const filtered = q
      ? allTypes.filter((et) => et.type.toLowerCase().includes(q))
      : allTypes;

    const grouped = filtered.reduce(
      (acc: Record<string, EventTypeEntry[]>, et) => {
        const parts = et.type.split(".");
        const table = parts[0];
        if (!acc[table]) acc[table] = [];
        acc[table].push({
          ...et,
          action: parts[1] || "",
          modifier: parts[2] || "",
        });
        return acc;
      },
      {}
    );

    return Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]));
  })();

  const eventTypeOptions =
    capabilities?.eventTypes?.map((et) => ({
      value: et.type,
      label: et.type,
    })) ?? [];

  return (
    <div className="w-full p-6 md:p-8">
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="m-0 text-2xl font-bold text-foreground">Events</h1>
          <Text className="mt-1 text-sm text-default-500">
            Search, explore, and publish events
          </Text>
        </div>

        <Tabs.Root
          selectedKey={activeTab}
          onSelectionChange={(k) => setActiveTab(String(k))}
          orientation="horizontal"
        >
          <Tabs.ListContainer>
            <Tabs.List className="mb-4 gap-1 overflow-x-auto">
              <Tabs.Tab id="search" className="px-3 py-2 text-sm">
                <span className="inline-flex items-center gap-1">
                  <IconSearch size={16} />
                  Search Events
                </span>
              </Tabs.Tab>
              <Tabs.Tab id="types" className="px-3 py-2 text-sm">
                <span className="inline-flex items-center gap-1">
                  <IconList size={16} />
                  Event Types
                  {capabilities?.eventTypes ? (
                    <Chip
                      size="sm"
                      variant="soft"
                      color="default"
                      className="ml-1"
                    >
                      {capabilities.eventTypes.length}
                    </Chip>
                  ) : null}
                </span>
              </Tabs.Tab>
              <Tabs.Tab id="publish" className="px-3 py-2 text-sm">
                <span className="inline-flex items-center gap-1">
                  <IconSend size={16} />
                  Publish Event
                </span>
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>

          <Tabs.Panel id="search" className="pt-4">
            <div className="flex flex-col gap-4">
              <Card className="rounded-xl border border-divider p-4">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[200px] flex-1">
                    <div className="relative">
                      <IconSearch
                        size={16}
                        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-default-400"
                      />
                      <Input
                        className={`${inputClass} pl-9 pr-9`}
                        placeholder="Filter by user ID, UUID (correlation), or leave empty…"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                      />
                      {searchTerm ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          className="absolute right-1 top-1/2 -translate-y-1/2"
                          aria-label="Clear search"
                          onPress={() => setSearchTerm("")}
                        >
                          <IconX size={14} />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="relative w-[min(220px,100%)]">
                    <select
                      className={cn(
                        inputClass,
                        "appearance-none pr-8 text-ellipsis text-left"
                      )}
                      value={eventTypeFilter ?? ""}
                      onChange={(e) =>
                        setEventTypeFilter(e.target.value || null)
                      }
                    >
                      <option value="">All types</option>
                      {eventTypeOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <IconChevronDown
                      size={14}
                      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-default-400"
                    />
                  </div>
                  <Button
                    variant={showAdvancedFilters ? "primary" : "ghost"}
                    size="sm"
                    isIconOnly
                    aria-label="Advanced filters"
                    onPress={() => setShowAdvancedFilters(!showAdvancedFilters)}
                  >
                    <IconFilter size={16} />
                  </Button>
                  {hasActiveFilters ? (
                    <Button variant="ghost" size="sm" onPress={clearFilters}>
                      Clear
                    </Button>
                  ) : null}
                </div>

                {showAdvancedFilters ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <div className="min-w-[160px] flex-1">
                      <Label className="text-xs text-default-600">From</Label>
                      <Input
                        type="datetime-local"
                        className={`${inputClass} mt-1`}
                        value={fromDate}
                        onChange={(e) => setFromDate(e.target.value)}
                      />
                    </div>
                    <div className="min-w-[160px] flex-1">
                      <Label className="text-xs text-default-600">To</Label>
                      <Input
                        type="datetime-local"
                        className={`${inputClass} mt-1`}
                        value={toDate}
                        onChange={(e) => setToDate(e.target.value)}
                      />
                    </div>
                  </div>
                ) : null}
              </Card>

              <Card className="rounded-xl border border-divider p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Text className="text-lg font-semibold">
                      {hasActiveFilters ? "Filtered Results" : "Recent Events"}
                    </Text>
                    {isFetchingSearch && !isLoadingSearch ? (
                      <Text className="text-xs text-default-500">
                        updating…
                      </Text>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Chip size="sm" variant="soft" color="default">
                      {events.length} events
                    </Chip>
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      aria-label="Refresh"
                      onPress={() => refetchSearch()}
                    >
                      <IconRefresh size={16} />
                    </Button>
                  </div>
                </div>

                <div className="max-h-[520px] overflow-y-auto">
                  <div className="flex flex-col gap-2">
                    {isLoadingSearch ? (
                      <SearchResultsSkeleton count={8} />
                    ) : events.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 py-10">
                        <Text className="text-sm text-default-500">
                          {hasActiveFilters
                            ? "No events match the current filters."
                            : "No events recorded yet."}
                        </Text>
                        {hasActiveFilters ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onPress={clearFilters}
                          >
                            Clear filters
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      events.map((event) => (
                        <Button
                          key={event.id}
                          variant="ghost"
                          className={cn(
                            "h-auto min-h-0 w-full justify-start rounded-lg border border-divider px-3 py-2 text-left transition-colors",
                            selectedEventId === event.id
                              ? "border-primary bg-primary/10"
                              : "bg-default-50 hover:bg-default-100"
                          )}
                          onPress={() => handleEventClick(event.id)}
                        >
                          <div className="flex w-full flex-wrap items-center justify-between gap-2">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <Chip
                                size="sm"
                                variant="soft"
                                color={
                                  (event.type ?? "").includes("error") ||
                                  (event.type ?? "").includes("failed")
                                    ? "danger"
                                    : "accent"
                                }
                                className="shrink-0 font-mono text-xs"
                              >
                                {event.type}
                              </Chip>
                              <span className="truncate font-mono text-xs text-default-500">
                                {event.id}
                              </span>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-default-500">
                              {event.userId ? (
                                <span>
                                  {event.userId.length > 20
                                    ? `${event.userId.slice(0, 8)}…`
                                    : event.userId}
                                </span>
                              ) : null}
                              <span>
                                {new Date(event.timestamp).toLocaleString()}
                              </span>
                            </div>
                          </div>
                        </Button>
                      ))
                    )}
                  </div>
                </div>
              </Card>
            </div>
          </Tabs.Panel>

          <Tabs.Panel id="types" className="pt-4">
            {selectedEventType ? (
              <EventTypeExplorer
                eventType={selectedEventType}
                onClose={() => setSelectedEventType(null)}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <Card className="rounded-xl border border-divider p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="relative min-w-[200px] flex-1">
                      <IconSearch
                        size={16}
                        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-default-400"
                      />
                      <Input
                        className={`${inputClass} pl-9 pr-9`}
                        placeholder="Filter event types…"
                        value={typesSearch}
                        onChange={(e) => setTypesSearch(e.target.value)}
                      />
                      {typesSearch ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          className="absolute right-1 top-1/2 -translate-y-1/2"
                          onPress={() => setTypesSearch("")}
                          aria-label="Clear"
                        >
                          <IconX size={14} />
                        </Button>
                      ) : null}
                    </div>
                    <Text className="text-sm text-default-500">
                      {filteredGrouped.length} table
                      {filteredGrouped.length !== 1 ? "s" : ""}
                      {typesSearch ? ` matching "${typesSearch}"` : ""}
                    </Text>
                  </div>
                  <Text className="mt-2 text-xs text-default-500">
                    Pattern: <code>table.action.modifier</code> — click a
                    modifier to explore
                  </Text>
                </Card>

                {filteredGrouped.map(([table, tableEvents]) => {
                  const isOpen = expandedTables.has(table) || !!typesSearch;
                  const byAction = tableEvents.reduce(
                    (acc: Record<string, EventTypeEntry[]>, e) => {
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
                      className="rounded-xl border border-divider p-4"
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        className="flex cursor-pointer items-center gap-2"
                        onClick={() => !typesSearch && toggleTable(table)}
                        onKeyDown={(e) => {
                          if (
                            !typesSearch &&
                            (e.key === "Enter" || e.key === " ")
                          ) {
                            e.preventDefault();
                            toggleTable(table);
                          }
                        }}
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                          <IconDatabase size={20} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <Text className="text-base font-semibold">
                            {table}
                          </Text>
                          <Text className="text-xs text-default-500">
                            {tableEvents.length} event type
                            {tableEvents.length !== 1 ? "s" : ""}
                          </Text>
                        </div>
                        {!typesSearch ? (
                          <span className="text-default-500">
                            {isOpen ? (
                              <IconChevronDown size={16} />
                            ) : (
                              <IconChevronRight size={16} />
                            )}
                          </span>
                        ) : null}
                      </div>

                      {isOpen ? (
                        <div className="mt-4 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                          {Object.entries(byAction)
                            .sort((a, b) => a[0].localeCompare(b[0]))
                            .map(([action, actionEvents]) => {
                              const modifiers = actionEvents
                                .map((e) => e.modifier)
                                .filter(Boolean);
                              const hasModifiers = modifiers.length > 0;

                              return (
                                <Card
                                  key={`${table}.${action}`}
                                  className="rounded-lg border border-divider bg-default-50 p-3"
                                >
                                  <div
                                    className={`mb-2 flex items-center gap-2 rounded-md p-1 ${actionTone(action)}`}
                                  >
                                    <span className="flex h-7 w-7 items-center justify-center rounded-sm bg-background/60">
                                      {actionIconNode(action)}
                                    </span>
                                    <Text className="text-sm font-medium">
                                      {action}
                                    </Text>
                                  </div>

                                  {hasModifiers ? (
                                    <div className="ml-2 flex flex-col gap-1 border-l-2 border-divider pl-3">
                                      {actionEvents.map((e) => (
                                        <button
                                          type="button"
                                          key={e.type}
                                          className="flex cursor-pointer flex-wrap items-center gap-2 text-left"
                                          onClick={() =>
                                            setSelectedEventType(e.type)
                                          }
                                        >
                                          <span className="text-xs text-default-400">
                                            →
                                          </span>
                                          <Chip
                                            size="sm"
                                            variant="soft"
                                            color={
                                              e.modifier === "requested"
                                                ? "accent"
                                                : e.modifier === "completed" ||
                                                    e.modifier === "validated"
                                                  ? "success"
                                                  : "default"
                                            }
                                          >
                                            {e.modifier}
                                          </Chip>
                                          {e.hasSchema ? (
                                            <Chip
                                              size="sm"
                                              variant="soft"
                                              color="warning"
                                            >
                                              Schema
                                            </Chip>
                                          ) : null}
                                        </button>
                                      ))}
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      className="mt-1 cursor-pointer text-left"
                                      onClick={() =>
                                        setSelectedEventType(
                                          actionEvents[0]?.type
                                        )
                                      }
                                    >
                                      <Text className="text-xs text-default-500">
                                        {actionEvents[0]?.type}
                                      </Text>
                                    </button>
                                  )}
                                </Card>
                              );
                            })}
                        </div>
                      ) : null}
                    </Card>
                  );
                })}

                {filteredGrouped.length === 0 ? (
                  <Text className="py-10 text-center text-sm text-default-500">
                    No event types match "{typesSearch}"
                  </Text>
                ) : null}
              </div>
            )}
          </Tabs.Panel>

          <Tabs.Panel id="publish" className="pt-4">
            <Card className="rounded-xl border border-divider p-4">
              <Text className="mb-1 text-lg font-semibold">
                Publish Test Event
              </Text>
              <Text className="mb-4 text-sm text-default-500">
                Inject an event directly into the event store for testing or
                debugging.
              </Text>
              <div className="flex flex-col gap-4">
                <div>
                  <Label className="text-default-600">Event Type</Label>
                  <div className="relative mt-1">
                    <select
                      className={cn(
                        inputClass,
                        "appearance-none pr-8 text-ellipsis text-left"
                      )}
                      value={publishEventType}
                      onChange={(e) => setPublishEventType(e.target.value)}
                      required
                    >
                      <option value="">Select event type</option>
                      {eventTypeOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <IconChevronDown
                      size={14}
                      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-default-400"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-default-600">User ID</Label>
                  <Text className="mb-1 text-xs text-default-500">
                    The user to attribute this event to
                  </Text>
                  <Input
                    className={inputClass}
                    placeholder="test-user"
                    value={publishUserId}
                    onChange={(e) => setPublishUserId(e.target.value)}
                  />
                </div>
                {publishEventType && publishSchema?.hasSchema ? (
                  <SchemaFormGenerator
                    eventType={publishEventType}
                    value={publishData}
                    onChange={setPublishData}
                    errors={{}}
                  />
                ) : null}
                {publishEventType && !publishSchema?.hasSchema ? (
                  <Text className="text-xs text-default-500">
                    No schema registered for this event type — it will be
                    published with empty data.
                  </Text>
                ) : null}
                <Button
                  variant="primary"
                  fullWidth
                  isDisabled={!publishEventType}
                  onPress={handlePublish}
                >
                  {publishMutation.isPending ? (
                    <Spinner size="sm" color="current" />
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <IconSend size={16} />
                      Publish Event
                    </span>
                  )}
                </Button>
              </div>
            </Card>
          </Tabs.Panel>
        </Tabs.Root>
      </div>

      <Drawer state={eventDrawer}>
        <Drawer.Backdrop isDismissable />
        <Drawer.Content placement="right" className="max-w-xl">
          <Drawer.Dialog>
            <Drawer.Handle />
            <Drawer.Header className="border-b border-divider px-4 py-3">
              <div className="flex items-center gap-2 pr-8">
                <IconTimeline size={20} className="text-accent" />
                <Drawer.Heading className="text-lg font-semibold">
                  Event Details & Trace
                </Drawer.Heading>
              </div>
              <Drawer.CloseTrigger />
            </Drawer.Header>
            <Drawer.Body className="gap-4 px-4 py-4">
              {traceData?.event ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-fit"
                  isDisabled={republishMutation.isPending}
                  onPress={handleRepublish}
                >
                  {republishMutation.isPending ? (
                    <Spinner size="sm" color="current" />
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <IconRefresh size={14} />
                      Republish Event
                    </span>
                  )}
                </Button>
              ) : null}

              {isLoadingTrace ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-36 rounded-md" />
                  <Skeleton className="h-24 rounded-md" />
                  <Skeleton className="h-40 rounded-md" />
                </div>
              ) : traceData ? (
                <div className="flex flex-col gap-6">
                  <div>
                    <Text className="mb-2 text-sm font-semibold">
                      Main Event
                    </Text>
                    <Card className="border border-divider bg-default-50 p-3">
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <IconTag size={15} className="text-default-400" />
                          <Chip
                            size="sm"
                            variant="soft"
                            color="accent"
                            className="font-mono text-xs"
                          >
                            {traceData.event.eventType}
                          </Chip>
                        </div>
                        <div className="flex items-center gap-2">
                          <IconClock size={15} className="text-default-400" />
                          <Text className="text-xs text-default-500">
                            {new Date(
                              traceData.event.timestamp
                            ).toLocaleString()}
                          </Text>
                        </div>
                        {traceData.event.userId ? (
                          <div className="flex items-center gap-2">
                            <IconUser size={15} className="text-default-400" />
                            <Text className="text-xs text-default-500">
                              {traceData.event.userId}
                            </Text>
                          </div>
                        ) : null}
                        <div className="flex items-center gap-2">
                          <IconCode size={15} className="text-default-400" />
                          <Text className="font-mono text-xs text-default-500">
                            {traceData.event.eventId}
                          </Text>
                        </div>
                        {traceData.event.correlationId ? (
                          <div className="flex items-center gap-2">
                            <IconTimeline
                              size={15}
                              className="text-default-400"
                            />
                            <Text className="font-mono text-xs text-default-500">
                              corr: {traceData.event.correlationId}
                            </Text>
                          </div>
                        ) : null}
                      </div>
                    </Card>
                  </div>

                  <Separator />

                  <div>
                    <Text className="mb-2 text-sm font-semibold">
                      Event Data
                    </Text>
                    <pre className="max-h-[220px] overflow-y-auto rounded-md border border-divider bg-default-50 p-3 font-mono text-xs">
                      {JSON.stringify(traceData.event.data, null, 2)}
                    </pre>
                  </div>

                  {traceData.relatedEvents &&
                  traceData.relatedEvents.length > 0 ? (
                    <>
                      <Separator />
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <Text className="text-sm font-semibold">
                            Correlated Events
                          </Text>
                          <Chip size="sm" variant="soft" color="accent">
                            {traceData.relatedEvents.length}
                          </Chip>
                        </div>
                        <div className="flex flex-col gap-4 border-l-2 border-divider pl-4">
                          {traceData.relatedEvents.map((relEvent) => (
                            <div key={relEvent.eventId} className="relative">
                              <div className="absolute -left-[21px] top-1 flex h-5 w-5 items-center justify-center rounded-full border border-divider bg-background">
                                <IconTimeline size={11} />
                              </div>
                              <Chip
                                size="sm"
                                variant="soft"
                                color="accent"
                                className="font-mono text-xs"
                              >
                                {relEvent.eventType}
                              </Chip>
                              <Text className="mt-1 text-xs text-default-500">
                                {new Date(relEvent.timestamp).toLocaleString()}
                              </Text>
                              <Text className="mt-1 font-mono text-xs text-default-500">
                                {relEvent.eventId}
                              </Text>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="mt-2 h-auto p-0"
                                onPress={() =>
                                  handleEventClick(relEvent.eventId)
                                }
                              >
                                <span className="inline-flex items-center gap-1 text-xs">
                                  <IconArrowRight size={12} />
                                  View details
                                </span>
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : null}

                  {traceData.relatedEvents?.length === 0 ? (
                    <Text className="text-center text-xs text-default-500">
                      No correlated events — this event has no correlation ID.
                    </Text>
                  ) : null}
                </div>
              ) : (
                <Text className="py-10 text-center text-sm text-default-500">
                  Event not found.
                </Text>
              )}
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer>
    </div>
  );
}

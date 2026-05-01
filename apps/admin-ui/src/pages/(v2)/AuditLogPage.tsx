import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Chip,
  Input,
  Modal,
  Spinner,
  Text,
  cn,
  useOverlayState,
} from "@heroui/react";
import {
  IconRefresh,
  IconShieldLock,
  IconUser,
  IconBolt,
  IconPlus,
  IconPencil,
  IconTrash,
  IconCheck,
  IconX,
  IconChevronLeft,
  IconChevronRight,
} from "@tabler/icons-react";
import { trpc } from "../../lib/trpc";
import { useWorkspace } from "../../lib/workspace";
import { spacing } from "../../theme/tokens";

const PAGE_SIZE = 50;

const SUBJECT_TYPE_LABELS: Record<string, string> = {
  workspaces: "Workspace",
  workspace_members: "Member",
  api_keys: "API key",
  proposals: "Proposal",
  agents: "Agent",
  users: "User",
  secrets: "Secret",
  intelligence_services: "IS",
  trusted_issuers: "Trusted issuer",
};

const COMMON_ACTIONS = [
  "create",
  "update",
  "delete",
  "approve",
  "reject",
  "validate",
  "grant",
  "revoke",
  "rotate",
  "add",
  "remove",
];

function actionTone(
  action: string
): "success" | "warning" | "danger" | "primary" | "secondary" | "default" {
  if (
    action === "create" ||
    action === "add" ||
    action === "approve" ||
    action === "validate" ||
    action === "grant"
  )
    return "success";
  if (action === "update" || action === "rotate") return "warning";
  if (
    action === "delete" ||
    action === "remove" ||
    action === "reject" ||
    action === "revoke"
  )
    return "danger";
  return "default";
}

function actionIcon(action: string) {
  if (action === "create" || action === "add") return <IconPlus size={11} />;
  if (action === "update" || action === "rotate")
    return <IconPencil size={11} />;
  if (action === "delete" || action === "remove" || action === "revoke")
    return <IconTrash size={11} />;
  if (action === "approve" || action === "validate" || action === "grant")
    return <IconCheck size={11} />;
  if (action === "reject") return <IconX size={11} />;
  return <IconBolt size={11} />;
}

function timeSince(date: Date | string) {
  const ms = Date.now() - new Date(date).getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function shortId(id: string) {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export default function AuditLogPage() {
  const { workspaceId, isAllWorkspaces, workspaceName } = useWorkspace();

  const [subjectType, setSubjectType] = useState<string>("");
  const [action, setAction] = useState<string>("");
  const [actorFilter, setActorFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const detailsModal = useOverlayState({
    isOpen: !!selectedId,
    onOpenChange: (open) => {
      if (!open) setSelectedId(null);
    },
  });

  const queryInput = useMemo(
    () => ({
      workspaceId: workspaceId ?? undefined,
      userId: actorFilter.trim() || undefined,
      subjectType: subjectType || undefined,
      action: action || undefined,
      fromDate: fromDate ? new Date(fromDate).toISOString() : undefined,
      toDate: toDate ? new Date(toDate).toISOString() : undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [workspaceId, actorFilter, subjectType, action, fromDate, toDate, page]
  );

  const auditQuery = trpc.system.listAuditLogs.useQuery(queryInput, {
    refetchInterval: 30_000,
  });

  const events = auditQuery.data?.events ?? [];
  const actors = auditQuery.data?.actors ?? {};
  const workspaces = auditQuery.data?.workspaces ?? {};
  const availableSubjectTypes = auditQuery.data?.availableSubjectTypes ?? [];

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedId) ?? null,
    [events, selectedId]
  );

  const resetFilters = () => {
    setSubjectType("");
    setAction("");
    setActorFilter("");
    setFromDate("");
    setToDate("");
    setPage(0);
  };

  const hasFilters = subjectType || action || actorFilter || fromDate || toDate;

  return (
    <div className="w-full" style={{ padding: spacing[8] }}>
      <div className="flex flex-col gap-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <IconShieldLock size={20} className="text-primary" />
              <h1 className="m-0 text-2xl font-bold text-foreground">
                Audit log
              </h1>
            </div>
            <Text className="mt-1 text-sm text-default-500">
              Governance events across the pod —{" "}
              {isAllWorkspaces ? (
                <>workspaces, members, API keys, proposals, agents, secrets.</>
              ) : (
                <>
                  scoped to{" "}
                  <span className="font-medium text-default-700">
                    {workspaceName}
                  </span>
                  .
                </>
              )}
            </Text>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => void auditQuery.refetch()}
            isDisabled={auditQuery.isFetching}
          >
            <span className="inline-flex items-center gap-2">
              <IconRefresh
                size={14}
                className={cn(auditQuery.isFetching && "animate-spin")}
              />
              Refresh
            </span>
          </Button>
        </div>

        {/* Filter bar */}
        <Card className="border border-divider">
          <div className="flex flex-wrap items-end gap-3 p-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-default-500">
                Subject type
              </label>
              <select
                className="rounded-lg border border-divider bg-default-50 px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                value={subjectType}
                onChange={(e) => {
                  setSubjectType(e.target.value);
                  setPage(0);
                }}
              >
                <option value="">All types</option>
                {availableSubjectTypes.map((t) => (
                  <option key={t} value={t}>
                    {SUBJECT_TYPE_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-default-500">
                Action
              </label>
              <select
                className="rounded-lg border border-divider bg-default-50 px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                value={action}
                onChange={(e) => {
                  setAction(e.target.value);
                  setPage(0);
                }}
              >
                <option value="">All actions</option>
                {COMMON_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex min-w-[200px] flex-1 flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-default-500">
                Actor (user ID or email substring)
              </label>
              <Input
                size="sm"
                placeholder="user_…"
                value={actorFilter}
                onChange={(e) => {
                  setActorFilter(e.target.value);
                  setPage(0);
                }}
                className="border-default-200 bg-background text-foreground"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-default-500">
                From
              </label>
              <input
                type="datetime-local"
                className="rounded-lg border border-divider bg-default-50 px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                value={fromDate}
                onChange={(e) => {
                  setFromDate(e.target.value);
                  setPage(0);
                }}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-default-500">
                To
              </label>
              <input
                type="datetime-local"
                className="rounded-lg border border-divider bg-default-50 px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                value={toDate}
                onChange={(e) => {
                  setToDate(e.target.value);
                  setPage(0);
                }}
              />
            </div>

            {hasFilters && (
              <Button variant="ghost" size="sm" onPress={resetFilters}>
                <span className="inline-flex items-center gap-1">
                  <IconX size={12} />
                  Clear
                </span>
              </Button>
            )}
          </div>
        </Card>

        {/* Event table */}
        <Card className="border border-divider">
          <div className="border-b border-divider px-4 py-2">
            <Text className="text-xs font-semibold uppercase tracking-wide text-default-500">
              Events ({events.length}
              {events.length === PAGE_SIZE ? "+" : ""})
            </Text>
          </div>

          {auditQuery.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner size="lg" color="accent" />
            </div>
          ) : auditQuery.isError ? (
            <div className="m-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
              {auditQuery.error.message}
            </div>
          ) : events.length === 0 ? (
            <div className="py-12 text-center">
              <Text className="text-sm text-default-500">
                No audit events match the current filter.
              </Text>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-divider bg-default-50/50 text-left text-xs uppercase tracking-wide text-default-500">
                    <th className="px-4 py-2">When</th>
                    <th className="px-4 py-2">Actor</th>
                    <th className="px-4 py-2">Action</th>
                    <th className="px-4 py-2">Subject</th>
                    {isAllWorkspaces && (
                      <th className="px-4 py-2">Workspace</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => {
                    const actor = actors[ev.userId];
                    const actorLabel =
                      actor?.email ?? actor?.name ?? shortId(ev.userId);
                    const ws = ev.workspaceId
                      ? workspaces[ev.workspaceId]
                      : null;
                    return (
                      <tr
                        key={ev.id}
                        className="cursor-pointer border-b border-divider/60 transition-colors hover:bg-default-100"
                        onClick={() => setSelectedId(ev.id)}
                      >
                        <td className="px-4 py-2 text-xs text-default-500">
                          <span title={new Date(ev.timestamp).toLocaleString()}>
                            {timeSince(ev.timestamp)}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5">
                            <IconUser size={12} className="text-default-400" />
                            <span className="text-xs text-foreground">
                              {actorLabel}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <Chip
                            size="sm"
                            variant="soft"
                            color={actionTone(ev.action)}
                          >
                            <span className="inline-flex items-center gap-1">
                              {actionIcon(ev.action)}
                              {ev.action || ev.eventType}
                            </span>
                          </Chip>
                        </td>
                        <td className="px-4 py-2 text-xs">
                          <span className="text-foreground">
                            {SUBJECT_TYPE_LABELS[ev.subjectType] ??
                              ev.subjectType}
                          </span>{" "}
                          <code className="text-default-400">
                            {shortId(ev.subjectId)}
                          </code>
                        </td>
                        {isAllWorkspaces && (
                          <td className="px-4 py-2 text-xs text-default-500">
                            {ws
                              ? ws.name
                              : ev.workspaceId
                                ? shortId(ev.workspaceId)
                                : "—"}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-divider px-4 py-2">
            <Text className="text-xs text-default-500">
              Page {page + 1}
              {events.length === PAGE_SIZE ? " · more available" : ""}
            </Text>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                isDisabled={page === 0}
                onPress={() => setPage((p) => Math.max(0, p - 1))}
              >
                <span className="inline-flex items-center gap-1">
                  <IconChevronLeft size={12} />
                  Prev
                </span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                isDisabled={events.length < PAGE_SIZE}
                onPress={() => setPage((p) => p + 1)}
              >
                <span className="inline-flex items-center gap-1">
                  Next
                  <IconChevronRight size={12} />
                </span>
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* Details modal */}
      <Modal state={detailsModal}>
        <Modal.Backdrop isDismissable>
          <Modal.Container size="lg" placement="center">
            <Modal.Dialog>
              <Modal.Header className="border-b border-divider px-5 py-4">
                <div className="flex flex-col gap-1">
                  <Modal.Heading className="text-base font-semibold">
                    Event detail
                  </Modal.Heading>
                  {selectedEvent && (
                    <code className="text-xs text-default-500">
                      {selectedEvent.eventType}
                    </code>
                  )}
                </div>
                <Modal.CloseTrigger className="absolute right-3 top-3" />
              </Modal.Header>
              <Modal.Body className="max-h-[70vh] overflow-y-auto px-5 py-4">
                {selectedEvent ? (
                  <EventDetailView
                    event={selectedEvent}
                    actor={actors[selectedEvent.userId]}
                    workspace={
                      selectedEvent.workspaceId
                        ? workspaces[selectedEvent.workspaceId]
                        : null
                    }
                  />
                ) : (
                  <Text className="text-sm text-default-500">No data.</Text>
                )}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

function EventDetailView({
  event,
  actor,
  workspace,
}: {
  event: {
    id: string;
    timestamp: Date | string;
    eventType: string;
    action: string;
    phase: string;
    subjectType: string;
    subjectId: string;
    userId: string;
    workspaceId: string | null;
    source: string;
    correlationId: string | null;
    data: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  };
  actor?: { id: string; email: string | null; name: string | null };
  workspace?: { id: string; name: string } | null;
}) {
  const meta: Array<[string, string]> = [
    ["When", new Date(event.timestamp).toISOString()],
    ["Action", event.action || "—"],
    ["Phase", event.phase || "—"],
    ["Subject", `${event.subjectType} · ${event.subjectId}`],
    ["Actor", actor?.email ?? actor?.name ?? event.userId],
    ["Actor ID", event.userId],
    [
      "Workspace",
      workspace
        ? `${workspace.name} (${workspace.id})`
        : (event.workspaceId ?? "—"),
    ],
    ["Source", event.source],
    ["Correlation ID", event.correlationId ?? "—"],
    ["Event ID", event.id],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {meta.map(([k, v]) => (
          <div key={k}>
            <Text className="text-default-400">{k}</Text>
            <Text className="break-all text-foreground">{v}</Text>
          </div>
        ))}
      </div>

      <div>
        <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-default-500">
          Data
        </Text>
        <pre className="overflow-auto rounded-lg border border-divider bg-default-50 p-3 font-mono text-xs text-foreground">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      </div>

      {event.metadata && (
        <div>
          <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-default-500">
            Metadata
          </Text>
          <pre className="overflow-auto rounded-lg border border-divider bg-default-50 p-3 font-mono text-xs text-foreground">
            {JSON.stringify(event.metadata, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

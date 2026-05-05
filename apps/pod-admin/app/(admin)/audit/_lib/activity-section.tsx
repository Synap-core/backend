"use client";

/**
 * Audit → Activity log sub-tab.
 *
 * Backed by `trpc.system.listAuditLogs`. Renders as a vertical timeline
 * (denser than ResourceRow): timestamp · actor · action · subject. Click
 * a row → side Drawer with the full event payload (data + metadata).
 *
 * Pagination is a "Load more" button — `listAuditLogs` already returns
 * up to 200 per page; we increment limit in 50-row chunks until we hit
 * the cap, then add an offset.
 */

import { Avatar, Button, Chip, useDisclosure } from "@heroui/react";
import {
  Activity,
  Check,
  Plus,
  RotateCw,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { DetailDrawer } from "../../components/detail-drawer";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { useFocusRow } from "../../components/use-focus-row";
import {
  type ActorSummary,
  type AuditFilters,
  type WorkspaceSummary,
} from "./filter-bar";
import { formatRelative, formatTimestamp, shortId } from "./format";

interface AuditEvent {
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
}

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

export function ActivitySection({
  filters,
  onAvailableSubjectTypes,
  onAvailableActors,
  onAvailableWorkspaces,
}: {
  filters: AuditFilters;
  onAvailableSubjectTypes: (types: string[]) => void;
  onAvailableActors: (actors: ActorSummary[]) => void;
  onAvailableWorkspaces: (ws: WorkspaceSummary[]) => void;
}) {
  // Backend takes a single workspaceId — when the user has selected zero
  // or many we send `undefined` and filter client-side. With exactly one
  // selected we push it to the server for an indexed scan.
  const wsForBackend =
    filters.workspaceIds.length === 1 ? filters.workspaceIds[0] : undefined;
  const userForBackend =
    filters.userIds.length === 1 ? filters.userIds[0] : undefined;
  // Backend takes a single action — push first selection only.
  const actionForBackend = filters.actions[0];

  const [page, setPage] = useState(0);

  const queryInput = useMemo(
    () => ({
      workspaceId: wsForBackend,
      userId: userForBackend,
      subjectType: filters.subjectType || undefined,
      action: actionForBackend,
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [
      wsForBackend,
      userForBackend,
      filters.subjectType,
      actionForBackend,
      filters.fromDate,
      filters.toDate,
      page,
    ]
  );

  // Reset to page 0 whenever filters (other than page) change.
  useEffect(() => {
    setPage(0);
  }, [
    wsForBackend,
    userForBackend,
    filters.subjectType,
    actionForBackend,
    filters.fromDate,
    filters.toDate,
  ]);

  const auditQuery = trpc.system.listAuditLogs.useQuery(queryInput, {
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  const events = (auditQuery.data?.events ?? []) as AuditEvent[];
  const actors =
    (auditQuery.data?.actors as Record<string, ActorSummary>) ?? {};
  const workspaces =
    (auditQuery.data?.workspaces as Record<string, WorkspaceSummary>) ?? {};
  const availableSubjectTypes = auditQuery.data?.availableSubjectTypes ?? [];

  // Surface available filter values up to the parent so the FilterBar
  // can render selects with real names. Only fires on data change.
  useEffect(() => {
    if (auditQuery.data) {
      onAvailableSubjectTypes(availableSubjectTypes);
      onAvailableActors(Object.values(actors));
      onAvailableWorkspaces(Object.values(workspaces));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditQuery.data]);

  // Apply client-side filters that the backend didn't apply:
  //   • action multi-select (we sent only the first to the server)
  //   • workspace multi-select (only sent when exactly one)
  //   • user multi-select (only sent when exactly one)
  const filtered = useMemo(() => {
    let out = events;
    if (filters.actions.length > 1) {
      const set = new Set(filters.actions);
      out = out.filter((e) => set.has(e.action));
    }
    if (filters.workspaceIds.length > 1) {
      const set = new Set(filters.workspaceIds);
      out = out.filter((e) => e.workspaceId && set.has(e.workspaceId));
    }
    if (filters.userIds.length > 1) {
      const set = new Set(filters.userIds);
      out = out.filter((e) => set.has(e.userId));
    }
    return out;
  }, [events, filters.actions, filters.workspaceIds, filters.userIds]);

  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const drawer = useDisclosure({
    isOpen: !!selected,
    onClose: () => setSelected(null),
  });

  // ?focus=<eventId> from ⌘K or Overview alerts. Open the drawer for the
  // matching event once data has landed; the row will scroll-and-highlight
  // as long as the event is on the current page.
  const focusId = useFocusRow({ ready: !auditQuery.isLoading });
  useEffect(() => {
    if (!focusId || selected) return;
    const found = filtered.find((e) => e.id === focusId);
    if (found) setSelected(found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, filtered]);

  return (
    <>
      <div className="rounded-lg ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]">
        {auditQuery.isLoading ? (
          <ResourceRowSkeleton count={6} />
        ) : auditQuery.isError ? (
          <ResourceRowError
            message="Couldn't load audit log."
            onRetry={() => void auditQuery.refetch()}
          />
        ) : filtered.length === 0 ? (
          <ResourceRowEmpty message="No audit events match the current filters." />
        ) : (
          <ol>
            {filtered.map((ev) => (
              <ActivityRow
                key={ev.id}
                event={ev}
                actor={actors[ev.userId]}
                workspace={ev.workspaceId ? workspaces[ev.workspaceId] : null}
                onSelect={() => setSelected(ev)}
              />
            ))}
          </ol>
        )}
      </div>

      {/* Pagination */}
      {events.length >= PAGE_SIZE && (
        <div className="mt-3 flex justify-center">
          <Button
            size="sm"
            variant="flat"
            radius="md"
            onPress={() => setPage((p) => p + 1)}
            isLoading={auditQuery.isFetching}
          >
            Load more
          </Button>
        </div>
      )}

      <EventDrawer
        event={selected}
        actor={selected ? actors[selected.userId] : undefined}
        workspace={
          selected?.workspaceId ? workspaces[selected.workspaceId] : null
        }
        isOpen={drawer.isOpen}
        onOpenChange={drawer.onOpenChange}
      />
    </>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function ActivityRow({
  event,
  actor,
  workspace,
  onSelect,
}: {
  event: AuditEvent;
  actor?: ActorSummary;
  workspace?: WorkspaceSummary | null;
  onSelect: () => void;
}) {
  const actorLabel = actor?.email ?? actor?.name ?? shortId(event.userId);
  const subjectLabel =
    SUBJECT_TYPE_LABELS[event.subjectType] ?? event.subjectType;

  const { Icon, tone } = actionPresentation(event.action);

  return (
    <li
      data-row-id={event.id}
      className="rounded-md border-b border-foreground/[0.05] last:border-b-0 transition-shadow"
    >
      <button
        type="button"
        onClick={onSelect}
        className="
          group flex w-full items-center gap-3 px-3 py-2.5
          text-left transition-colors hover:bg-content2/40
          focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30
        "
      >
        {/* Timestamp */}
        <div className="flex w-[110px] shrink-0 flex-col text-[10.5px] tabular text-foreground/45">
          <span title={new Date(event.timestamp).toISOString()}>
            {formatRelative(event.timestamp)}
          </span>
          <span className="text-foreground/30">
            {formatTimestamp(event.timestamp)}
          </span>
        </div>

        {/* Actor */}
        <div className="flex w-[150px] shrink-0 items-center gap-1.5">
          <Avatar
            size="sm"
            name={actorLabel}
            classNames={{
              base: "h-5 w-5 text-[10px] bg-foreground/[0.08] text-foreground/70",
              name: "text-[10px]",
            }}
          />
          <span className="truncate text-[11.5px] text-foreground/85">
            {actorLabel}
          </span>
        </div>

        {/* Action */}
        <div className="w-[100px] shrink-0">
          <Chip
            size="sm"
            radius="sm"
            variant="flat"
            startContent={<Icon className="ml-1 h-3 w-3" />}
            classNames={{
              base: `${tone.bg} ring-1 ring-inset ${tone.ring}`,
              content: `text-[11px] font-medium ${tone.text}`,
            }}
          >
            {event.action || "—"}
          </Chip>
        </div>

        {/* Subject */}
        <div className="min-w-0 flex-1 truncate text-[11.5px]">
          <span className="text-foreground/85">{subjectLabel}</span>{" "}
          <code className="text-foreground/45">{shortId(event.subjectId)}</code>
        </div>

        {/* Workspace */}
        <div className="w-[160px] shrink-0 truncate text-right text-[11px] text-foreground/45">
          {workspace ? workspace.name : event.workspaceId ? "—" : "pod-level"}
        </div>
      </button>
    </li>
  );
}

function actionPresentation(action: string): {
  Icon: LucideIcon;
  tone: { bg: string; text: string; ring: string };
} {
  if (
    action === "create" ||
    action === "approve" ||
    action === "validate" ||
    action === "grant"
  )
    return {
      Icon: action === "create" ? Plus : Check,
      tone: {
        bg: "bg-status-healthy/10",
        text: "text-status-healthy",
        ring: "ring-status-healthy/30",
      },
    };
  if (action === "update" || action === "rotate")
    return {
      Icon: RotateCw,
      tone: {
        bg: "bg-status-stale/10",
        text: "text-status-stale",
        ring: "ring-status-stale/30",
      },
    };
  if (action === "delete" || action === "revoke" || action === "reject")
    return {
      Icon: action === "delete" ? Trash2 : X,
      tone: {
        bg: "bg-status-down/10",
        text: "text-status-down",
        ring: "ring-status-down/30",
      },
    };
  return {
    Icon: Activity,
    tone: {
      bg: "bg-foreground/5",
      text: "text-foreground/55",
      ring: "ring-foreground/10",
    },
  };
}

// ─── Drawer ───────────────────────────────────────────────────────────────

function EventDrawer({
  event,
  actor,
  workspace,
  isOpen,
  onOpenChange,
}: {
  event: AuditEvent | null;
  actor?: ActorSummary;
  workspace?: WorkspaceSummary | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DetailDrawer
      isOpen={isOpen}
      onClose={() => onOpenChange(false)}
      title="Event detail"
      subtitle={
        event ? <code className="font-mono">{event.eventType}</code> : undefined
      }
      headerAccessory={
        <span
          className="glass-icon flex h-7 w-7 items-center justify-center"
          style={{ background: "rgba(52, 211, 153, 0.15)" }}
        >
          <Activity className="h-3.5 w-3.5 text-foreground/85" />
        </span>
      }
    >
      {event ? (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[11.5px]">
            <Field k="When" v={new Date(event.timestamp).toLocaleString()} />
            <Field k="Action" v={event.action || "—"} />
            <Field k="Phase" v={event.phase || "—"} />
            <Field
              k="Subject"
              v={`${SUBJECT_TYPE_LABELS[event.subjectType] ?? event.subjectType}`}
            />
            <Field k="Subject ID" v={event.subjectId} mono />
            <Field k="Actor" v={actor?.email ?? actor?.name ?? event.userId} />
            <Field k="Actor ID" v={event.userId} mono />
            <Field
              k="Workspace"
              v={
                workspace
                  ? `${workspace.name}`
                  : (event.workspaceId ?? "pod-level")
              }
            />
            <Field k="Source" v={event.source} />
            <Field k="Correlation" v={event.correlationId ?? "—"} mono />
          </dl>

          <div className="mt-4">
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-foreground/45">
              Data
            </p>
            <pre className="overflow-auto rounded-md bg-foreground/[0.04] p-3 font-mono text-[11px] text-foreground/85 ring-1 ring-inset ring-foreground/10">
              {JSON.stringify(event.data, null, 2)}
            </pre>
          </div>

          {event.metadata && (
            <div className="mt-4">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-foreground/45">
                Metadata
              </p>
              <pre className="overflow-auto rounded-md bg-foreground/[0.04] p-3 font-mono text-[11px] text-foreground/85 ring-1 ring-inset ring-foreground/10">
                {JSON.stringify(event.metadata, null, 2)}
              </pre>
            </div>
          )}
        </>
      ) : null}
    </DetailDrawer>
  );
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10.5px] uppercase tracking-wide text-foreground/45">
        {k}
      </dt>
      <dd
        className={[
          "break-all text-foreground/85",
          mono ? "font-mono text-[10.5px]" : "",
        ].join(" ")}
      >
        {v}
      </dd>
    </div>
  );
}

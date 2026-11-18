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

import { Button, useDisclosure } from "@heroui/react";
import { Activity } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  normalizeObjectKind,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { DetailDrawer } from "../../components/detail-drawer";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { useFocusRow } from "../../components/use-focus-row";
import { useT } from "../../../../lib/i18n/locale-provider";
import { CATALOGS } from "./copy";
import {
  presenceMissingQuery,
  type PresenceMissingLens,
} from "./presence-missing-link";
import {
  type ActorSummary,
  type AuditFilters,
  type WorkspaceSummary,
} from "./filter-bar";
import { formatTimestamp, shortId } from "../../../../lib/format";
import { TimelineList } from "../../../_lib/timeline/timeline-list";
import { auditEntry } from "../../../_lib/timeline/timeline-model";

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
/** Rows shown before "Show all". */
const SHOWN_ROWS = 25;

/**
 * An audit row's `subjectType` is the DB TABLE the row touched — plural
 * (`api_keys`), where the object registry is keyed singular (`api_key`).
 *
 * Both halves come from the SSOT. `normalizeObjectKind` is the registry's own
 * depluralizer AND alias resolver, so `workflows` lands on `automation` — which
 * a hand-rolled `.slice(0, -1)` gets wrong. Writing that helper locally is the
 * very thing this file was being fixed for.
 */
function subjectTypeLabel(subjectType: string): string {
  return resolveObjectNoun(normalizeObjectKind(subjectType));
}

export function ActivitySection({
  filters,
  lens,
  onAvailableSubjectTypes,
  onAvailableActors,
  onAvailableWorkspaces,
}: {
  filters: AuditFilters;
  /** The "went through without a proof" lens, from the address; `null` = off. */
  lens: PresenceMissingLens | null;
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
  const t = useT(CATALOGS);

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
      presenceMissing: presenceMissingQuery(lens),
    }),
    [
      wsForBackend,
      userForBackend,
      filters.subjectType,
      actionForBackend,
      filters.fromDate,
      filters.toDate,
      page,
      lens,
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
    lens,
  ]);

  const auditQuery = trpc.system.listAuditLogs.useQuery(queryInput, {
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  // Expired session → login, not a dead "couldn't load" error.
  useEffect(() => {
    if (auditQuery.isError) {
      redirectToLoginIfUnauthorized(auditQuery.error);
    }
  }, [auditQuery.isError, auditQuery.error]);
  const isAuthRedirecting = auditQuery.error?.data?.code === "UNAUTHORIZED";

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

  const [showAll, setShowAll] = useState(false);
  const byId = useMemo(() => new Map(filtered.map((e) => [e.id, e])), [filtered]);
  const entries = useMemo(
    () =>
      filtered.map((ev) => {
        const actor = actors[ev.userId];
        return auditEntry({
          id: ev.id,
          timestamp: ev.timestamp,
          action: ev.action,
          phase: ev.phase,
          subject: `${subjectTypeLabel(ev.subjectType)} ${shortId(ev.subjectId)}`,
          subjectType: ev.subjectType,
          subjectId: ev.subjectId,
          userId: ev.userId,
          actorName: actor?.email ?? actor?.name ?? shortId(ev.userId),
        });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, auditQuery.data]
  );

  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const drawer = useDisclosure({
    isOpen: !!selected,
    onClose: () => setSelected(null),
  });

  // ?focus=<eventId> from ⌘K. Open the drawer for the
  // matching event once data has landed; the row will scroll-and-highlight
  // as long as the event is on the current page.
  const focusId = useFocusRow({ ready: !auditQuery.isLoading });
  useEffect(() => {
    if (!focusId || selected) return;
    const found = filtered.find((e) => e.id === focusId);
    if (found) setSelected(found);
  }, [focusId, filtered]);

  return (
    <>
      <div className="rounded-lg ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]">
        {auditQuery.isLoading || isAuthRedirecting ? (
          <ResourceRowSkeleton count={6} />
        ) : auditQuery.isError ? (
          <ResourceRowError
            message="Couldn't load audit log."
            onRetry={() => void auditQuery.refetch()}
          />
        ) : filtered.length === 0 ? (
          <ResourceRowEmpty
            message={
              lens
                ? t("lens.empty")
                : "No audit events match the current filters."
            }
          />
        ) : (
          <TimelineList
            entries={entries}
            cap={SHOWN_ROWS}
            expanded={showAll || !!focusId}
            onExpand={() => setShowAll(true)}
            showAllLabel={t("showAll", { n: filtered.length })}
            onSelect={(e) => setSelected(byId.get(e.key) ?? null)}
            detail={(e) => {
              const ev = byId.get(e.key);
              if (!ev?.workspaceId) return t("podWide");
              return workspaces[ev.workspaceId]?.name ?? null;
            }}
          />
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
            <Field k="When" v={formatTimestamp(event.timestamp)} />
            <Field k="Action" v={event.action || "—"} />
            <Field k="Phase" v={event.phase || "—"} />
            <Field k="Subject" v={subjectTypeLabel(event.subjectType)} />
            <Field k="Subject ID" v={event.subjectId} mono />
            <Field k="Actor" v={actor?.email ?? actor?.name ?? event.userId} />
            <Field k="Actor ID" v={event.userId} mono />
            <Field
              k="Space"
              v={
                workspace
                  ? `${workspace.name}`
                  : (event.workspaceId ?? "Pod-wide")
              }
            />
            <Field k="Source" v={event.source} />
            <Field k="Correlation" v={event.correlationId ?? "—"} mono />
          </dl>

          <div className="mt-4">
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-foreground/65">
              Data
            </p>
            <pre className="overflow-auto rounded-md bg-foreground/[0.04] p-3 font-mono text-[11px] text-foreground/85 ring-1 ring-inset ring-foreground/10">
              {JSON.stringify(event.data, null, 2)}
            </pre>
          </div>

          {event.metadata && (
            <div className="mt-4">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-foreground/65">
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
      <dt className="text-[10.5px] uppercase tracking-wide text-foreground/65">
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

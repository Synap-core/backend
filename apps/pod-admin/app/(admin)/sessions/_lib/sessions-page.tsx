"use client";

/**
 * Sessions — every piece of work on the pod the viewer can see, by where it
 * stands. The segment rules live in `session-rows.ts`; this file only reads
 * and renders.
 *
 * Reads (all user-floored, like every session door — decision D1):
 *   • `focusSessions.browse` over the open statuses with liveness — ONE page
 *     feeds both Running and Stuck (split client-side by `splitOpen`, the
 *     status filter itself applied in SQL before the limit).
 *   • `focusSessions.owed` — Waiting on you.
 *   • `focusSessions.browse` by status for Idle and Closed, only when shown.
 * Names for the space, project and owner come from the pod-wide lists the
 * console already reads; a failed name read leaves the name out.
 *
 * Acts are the owner's (`viewerRole`): pause/resume (`update {status}`) and
 * close (`close`, behind a confirm). A refusal from the pod is shown as it
 * came. `?filter=` picks the segment; `?focus=<sessionId>` highlights a row.
 */

import { Button, addToast } from "@heroui/react";
import { ArrowRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { navHref } from "../../../../lib/console-nav";
import { useReplaceParams } from "../../../../lib/use-replace-params";
import { kindIcon } from "../../../_lib/object/kind-icon";
import { ConfirmModal } from "../../components/confirm-modal";
import { PageHeader, PageShell } from "../../components/page-header";
import { FilterChips } from "../../components/filter-chips";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { useFocusRow } from "../../components/use-focus-row";
import {
  ACT_LABEL,
  CLOSED_STATUSES,
  IDLE_STATUSES,
  OPEN_RUN_STATUSES,
  SEGMENT_PARAM,
  SESSIONS_DESCRIPTION,
  SESSIONS_TITLE,
  SESSION_SEGMENTS,
  STUCK_AFTER_HOURS,
  segmentOf,
  sessionRow,
  splitOpen,
  waitingRows,
  type Names,
  type SessionAct,
  type SessionRow,
  type SessionSegment,
} from "./session-rows";

/** browse's ceiling for one page. */
const OPEN_LIMIT = 100;
const PAGE_STEP = 30;
const OWED_LIMIT = 200;

const EMPTY: Record<SessionSegment, string> = {
  running: "Nothing is running.",
  stuck: `Nothing is stuck. A session counts as stuck when it is still open ${STUCK_AFTER_HOURS} hours after it started and no agent is working on it.`,
  waiting: "No session is waiting on you.",
  idle: "No session has gone idle.",
  closed: "No closed sessions yet.",
};

const SessionIcon = kindIcon("session");

export function SessionsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const replaceParams = useReplaceParams();
  const segment = segmentOf(searchParams.get(SEGMENT_PARAM));
  const utils = trpc.useUtils();

  // ── Reads ──────────────────────────────────────────────────────────────────
  const open = trpc.focusSessions.browse.useQuery(
    { status: [...OPEN_RUN_STATUSES], liveness: true, limit: OPEN_LIMIT },
    { staleTime: 15_000, refetchInterval: 60_000 }
  );
  const owed = trpc.focusSessions.owed.useQuery(
    { limit: OWED_LIMIT },
    { staleTime: 15_000, refetchInterval: 60_000 }
  );
  const [settledLimit, setSettledLimit] = useState(PAGE_STEP);
  const settled = trpc.focusSessions.browse.useQuery(
    {
      status: segment === "idle" ? [...IDLE_STATUSES] : [...CLOSED_STATUSES],
      limit: settledLimit,
    },
    {
      enabled: segment === "idle" || segment === "closed",
      staleTime: 30_000,
    }
  );
  const workspaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });
  const projects = trpc.projects.list.useQuery(
    { limit: 200 },
    { staleTime: 60_000 }
  );
  const people = trpc.workspaces.listPodMembers.useQuery(undefined, {
    staleTime: 60_000,
  });

  useEffect(() => {
    const err = open.error ?? owed.error ?? settled.error;
    if (err) redirectToLoginIfUnauthorized(err);
  }, [open.error, owed.error, settled.error]);

  const names: Names = useMemo(
    () => ({
      workspaces: new Map(
        (workspaces.data ?? []).map((w) => [w.id, w.name] as const)
      ),
      projects: new Map(
        (projects.data?.items ?? []).map((p) => [p.id, p.name] as const)
      ),
      people: new Map(
        (people.data ?? []).map((m) => [m.id, m.name ?? m.email] as const)
      ),
    }),
    [workspaces.data, projects.data, people.data]
  );

  // The clock each split reads is the moment its page was fetched: liveness
  // was true THEN, and a render must not re-judge it against a later clock.
  const openAt = open.dataUpdatedAt;
  const settledAt = settled.dataUpdatedAt;
  const split = useMemo(
    () => splitOpen(open.data?.items ?? [], openAt),
    [open.data, openAt]
  );
  const waiting = useMemo(
    () => waitingRows(owed.data ?? [], names),
    [owed.data, names]
  );

  const rows: SessionRow[] = useMemo(() => {
    switch (segment) {
      case "running":
        return split.running.map((s) => sessionRow(s, segment, names, openAt));
      case "stuck":
        return split.stuck.map((s) => sessionRow(s, segment, names, openAt));
      case "waiting":
        return waiting;
      default:
        return (settled.data?.items ?? []).map((s) =>
          sessionRow(s, segment, names, settledAt)
        );
    }
  }, [segment, split, waiting, settled.data, names, openAt, settledAt]);

  const source =
    segment === "running" || segment === "stuck"
      ? open
      : segment === "waiting"
        ? owed
        : settled;
  useFocusRow({ ready: !source.isLoading });

  // Counts only where the read is complete — a capped page is "100+".
  const openCapped = open.data?.pagination.hasMore ?? false;
  const counts: Partial<Record<SessionSegment, string>> = {
    ...(open.data
      ? {
          running: `${split.running.length}${openCapped ? "+" : ""}`,
          stuck: `${split.stuck.length}${openCapped ? "+" : ""}`,
        }
      : {}),
    ...(owed.data ? { waiting: String(waiting.length) } : {}),
  };

  /** For the stuck banner; the chips write the same URL themselves. */
  function showStuck() {
    setSettledLimit(PAGE_STEP);
    replaceParams((params) => {
      params.set(SEGMENT_PARAM, "stuck");
      params.delete("focus");
    });
  }

  // ── Acts ───────────────────────────────────────────────────────────────────
  const refresh = () => {
    void utils.focusSessions.browse.invalidate();
    void utils.focusSessions.owed.invalidate();
  };
  const refused = (err: {
    message: string;
    data?: { code?: string | null } | null;
  }) => {
    if (redirectToLoginIfUnauthorized(err)) return;
    addToast({
      title: "That didn’t go through",
      description: err.message,
      color: "danger",
    });
  };
  const update = trpc.focusSessions.update.useMutation({
    onSuccess: refresh,
    onError: refused,
  });
  const [closing, setClosing] = useState<SessionRow | null>(null);
  const close = trpc.focusSessions.close.useMutation({
    onSuccess: (res) => {
      setClosing(null);
      refresh();
      const warning = res.warnings?.[0];
      addToast({
        title: "Session closed",
        ...(warning ? { description: warning } : {}),
        color: warning ? "warning" : "success",
      });
    },
    onError: refused,
  });

  function act(row: SessionRow, a: SessionAct) {
    if (a === "close") setClosing(row);
    else
      update.mutate({
        id: row.id,
        status: a === "pause" ? "paused" : "active",
      });
  }

  const busyId = update.isPending ? update.variables?.id : undefined;
  const settledCapped =
    (segment === "idle" || segment === "closed") &&
    (settled.data?.pagination.hasMore ?? false);

  return (
    <PageShell>
      <PageHeader title={SESSIONS_TITLE} description={SESSIONS_DESCRIPTION} />

      <FilterChips
        param={SEGMENT_PARAM}
        defaultKey="running"
        active={segment}
        ariaLabel="Show"
        chips={SESSION_SEGMENTS.map((s) => ({ ...s, count: counts[s.key] }))}
        onSelect={() => setSettledLimit(PAGE_STEP)}
      />

      {segment === "running" && split.stuck.length > 0 && (
        <button
          type="button"
          onClick={showStuck}
          className="mb-4 flex min-h-10 w-full items-center justify-between gap-3 rounded-lg bg-status-stale/10 px-3 py-2 text-left text-[12.5px] text-foreground ring-1 ring-inset ring-status-stale/30 transition-colors hover:bg-status-stale/15"
        >
          <span>
            {split.stuck.length}{" "}
            {split.stuck.length === 1 ? "session looks" : "sessions look"} stuck
            — still open after {STUCK_AFTER_HOURS}h with no agent on{" "}
            {split.stuck.length === 1 ? "it" : "them"}.
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 font-medium">
            Review stuck
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </button>
      )}

      <section className="divide-y divide-foreground/[0.05] rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10">
        {source.isLoading ? (
          <ResourceRowSkeleton count={5} />
        ) : source.isError ? (
          <ResourceRowError
            message="Couldn't load sessions."
            onRetry={() => void source.refetch()}
          />
        ) : rows.length === 0 ? (
          <ResourceRowEmpty message={EMPTY[segment]} />
        ) : (
          rows.map((row) => (
            <div key={row.id} data-row-id={row.id} className="rounded-md">
              <ResourceRow
                Icon={SessionIcon}
                primary={row.title}
                secondary={row.secondary}
                status={row.pill ?? undefined}
                wrap
                onSelect={() => router.push(`${navHref("sessions")}/${row.id}`)}
                actions={
                  row.acts.primary ? (
                    <RowActs
                      row={row}
                      busy={busyId === row.id}
                      onAct={(a) => act(row, a)}
                    />
                  ) : undefined
                }
              />
            </div>
          ))
        )}
      </section>

      {(segment === "running" || segment === "stuck") && openCapped && (
        <p className="mt-2 px-1 text-[12px] text-foreground/65">
          Showing the {OPEN_LIMIT} most recently active open sessions.
        </p>
      )}
      {settledCapped && (
        <div className="mt-3 flex justify-center">
          {settledLimit < OPEN_LIMIT ? (
            <Button
              size="sm"
              variant="flat"
              radius="md"
              isLoading={settled.isFetching}
              onPress={() =>
                setSettledLimit((n) => Math.min(n + PAGE_STEP, OPEN_LIMIT))
              }
            >
              Show more
            </Button>
          ) : (
            <p className="text-[12px] text-foreground/65">
              Showing the {OPEN_LIMIT} most recent. Open the app to search
              further back.
            </p>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={closing !== null}
        onClose={() => setClosing(null)}
        onConfirm={() => closing && close.mutate({ id: closing.id })}
        title="Close this session?"
        consequence={
          <>
            “{closing?.title}” is marked closed and leaves the open list.
            Whatever it already applied stays; if it declared criteria that are
            not met, the close records that.
          </>
        }
        confirmLabel="Close session"
        confirmColor="warning"
        isPending={close.isPending}
      />
    </PageShell>
  );
}

function RowActs({
  row,
  busy,
  onAct,
}: {
  row: SessionRow;
  busy: boolean;
  onAct: (a: SessionAct) => void;
}) {
  const { primary, secondary } = row.acts;
  if (!primary) return null;
  return (
    <div className="flex items-center gap-1.5">
      {secondary && (
        <Button
          size="sm"
          variant="light"
          radius="md"
          className="hidden sm:inline-flex"
          isDisabled={busy}
          onPress={() => onAct(secondary)}
          aria-label={`${ACT_LABEL[secondary]} ${row.title}`}
        >
          {ACT_LABEL[secondary]}
        </Button>
      )}
      <Button
        size="sm"
        variant="flat"
        radius="md"
        isLoading={busy}
        onPress={() => onAct(primary)}
        aria-label={`${ACT_LABEL[primary]} ${row.title}`}
      >
        {ACT_LABEL[primary]}
      </Button>
    </div>
  );
}

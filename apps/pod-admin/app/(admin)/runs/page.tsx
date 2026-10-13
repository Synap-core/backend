"use client";

/**
 * Runs — every flow that ran, whether it worked, and why not.
 *
 * All / Failing read the per-flow board, `runs.groups` (one row per rule or
 * template, exact counts over the whole ledger, cursor "Load more"); a flow
 * row expands into its recent runs (`runs.list({flowType, flowId})`). Running
 * and Failed AI turns read the per-run feed, `runs.list` with its keyset
 * cursor — those runs (sessions, tools, chat turns) have no flow to group
 * under. Any run opens its drawer (`run-drawer.tsx`). All reads are
 * user-floored (D1a).
 *
 * Receivers: `?filter=` (all · failing · running · chat) and
 * `?focus=<flowId>` on the board.
 */

import { Button } from "@heroui/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
import { kindIcon } from "../../_lib/object/kind-icon";
import { statusPillFor } from "../components/status-tone";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import { useFocusRow } from "../components/use-focus-row";
import { FilterChips } from "../components/filter-chips";
import {
  failingBoardComplete,
  flowHealthSentence,
  flowHref,
  flowIsFailing,
  flowNoun,
  RUN_FILTERS,
  runFilterOf,
  runListInput,
  runRowSecondary,
} from "./_lib/run-board";
import { RunDrawer, type RunTarget } from "./_lib/run-drawer";

const TITLE = "Runs";
const DESCRIPTION = "Every flow that ran, whether it worked, and why not.";
const PAGE_SIZE = 50;
/** Runs shown when a flow is expanded. */
const FLOW_RUNS = 10;

export default function RunsPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <RunsInner />
    </Suspense>
  );
}

function RunsInner() {
  const searchParams = useSearchParams();
  const filter = runFilterOf(searchParams.get("filter"));
  const listInput = runListInput(filter);
  const [target, setTarget] = useState<RunTarget | null>(null);

  return (
    <PageShell>
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <FilterChips
        param="filter"
        defaultKey="all"
        active={filter}
        chips={RUN_FILTERS}
      />
      {listInput ? (
        <RunFeed
          key={filter}
          input={listInput}
          filter={filter}
          onOpen={setTarget}
        />
      ) : (
        <FlowBoard failingOnly={filter === "failing"} onOpen={setTarget} />
      )}
      <RunDrawer target={target} onClose={() => setTarget(null)} />
    </PageShell>
  );
}

// ─── The per-flow board (All · Failing) ───────────────────────────────

function FlowBoard({
  failingOnly,
  onOpen,
}: {
  failingOnly: boolean;
  onOpen: (t: RunTarget) => void;
}) {
  const groups = trpc.runs.groups.useInfiniteQuery(
    { limit: PAGE_SIZE },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      staleTime: 15_000,
    }
  );
  useEffect(() => {
    if (groups.isError) redirectToLoginIfUnauthorized(groups.error);
  }, [groups.isError, groups.error]);
  const isAuthRedirecting = groups.error?.data?.code === "UNAUTHORIZED";

  const loaded = useMemo(
    () => (groups.data?.pages ?? []).flatMap((p) => p.groups),
    [groups.data]
  );
  const complete = failingBoardComplete(
    loaded,
    groups.hasNextPage ?? false,
    new Date()
  );
  // Failing is a filter over a cursor read: keep paging until no failing flow
  // can be further down (`failingBoardComplete`), so the board never shows a
  // partial answer as the whole one.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = groups;
  useEffect(() => {
    if (failingOnly && !complete && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [failingOnly, complete, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const rows = failingOnly ? loaded.filter(flowIsFailing) : loaded;
  const loading =
    groups.isLoading || isAuthRedirecting || (failingOnly && !complete);
  useFocusRow({ ready: !loading });

  return (
    <SectionCard
      title={failingOnly ? "Failing flows" : "Flows"}
      hint="Rules and templates, newest run first. Tap one for its runs."
    >
      {loading && rows.length === 0 ? (
        <ResourceRowSkeleton count={4} />
      ) : groups.isError ? (
        <ResourceRowError
          message="Couldn't load runs."
          onRetry={() => void groups.refetch()}
        />
      ) : rows.length === 0 ? (
        <ResourceRowEmpty
          message={
            failingOnly
              ? "Nothing failed this week."
              : "Nothing has run yet. Rules and templates show here once they run."
          }
        />
      ) : (
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {rows.map((g) => (
            <FlowRow
              key={`${g.flowType}:${g.flowId}`}
              group={g}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
      {!failingOnly && groups.hasNextPage && (
        <div className="px-1 pt-3">
          <Button
            size="sm"
            variant="light"
            radius="md"
            isLoading={groups.isFetchingNextPage}
            onPress={() => void groups.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

type FlowGroup = {
  flowType: "automation" | "playbook";
  flowId: string;
  flowName: string;
  runCount: number;
  recentFailedCount: number;
  runningCount: number;
  latestStatus: string;
  latestStartedAt: Date | string;
};

function FlowRow({
  group,
  onOpen,
}: {
  group: FlowGroup;
  onOpen: (t: RunTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const noun = flowNoun(group.flowType);
  const pill = statusPillFor(group.latestStatus);
  return (
    <div data-row-id={group.flowId} className="rounded-md transition-shadow">
      <ResourceRow
        Icon={kindIcon(group.flowType)}
        primary={group.flowName}
        secondary={`${noun} · ${flowHealthSentence(group)} · last ran ${formatRelative(group.latestStartedAt)}`}
        status={pill ?? undefined}
        onSelect={() => setOpen((v) => !v)}
        wrap
        actions={
          <Button
            isIconOnly
            size="sm"
            variant="light"
            radius="full"
            aria-label={open ? "Hide its runs" : "Show its runs"}
            aria-expanded={open}
            className="text-foreground/55"
            onPress={() => setOpen((v) => !v)}
          >
            {open ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        }
      />
      {open && <FlowRuns group={group} onOpen={onOpen} />}
    </div>
  );
}

function FlowRuns({
  group,
  onOpen,
}: {
  group: FlowGroup;
  onOpen: (t: RunTarget) => void;
}) {
  const runs = trpc.runs.list.useQuery(
    { flowType: group.flowType, flowId: group.flowId, limit: FLOW_RUNS },
    { staleTime: 15_000 }
  );
  const href = flowHref(group.flowType, group.flowId);
  const list = runs.data?.runs ?? [];
  return (
    <div className="mb-2 ml-6 divide-y divide-foreground/[0.05] border-l border-foreground/[0.08] pl-2">
      {runs.isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : runs.isError ? (
        <ResourceRowError
          message="Its runs couldn't be loaded."
          onRetry={() => void runs.refetch()}
        />
      ) : list.length === 0 ? (
        <ResourceRowEmpty message="No runs you can see." />
      ) : (
        list.map((run) => (
          <ResourceRow
            key={run.id}
            Icon={kindIcon("run")}
            primary={formatRelative(run.startedAt, { empty: "Run" })}
            secondary={runRowSecondary(run)}
            status={statusPillFor(run.status) ?? undefined}
            onSelect={() =>
              onOpen({
                flowType: run.flowType,
                id: run.id,
                flowName: run.flowName,
              })
            }
            wrap
          />
        ))
      )}
      {href && (
        <Link
          href={href}
          className="inline-flex min-h-10 items-center px-3 text-[12.5px] text-foreground/70 hover:text-foreground hover:underline"
        >
          Open this {flowNoun(group.flowType).toLowerCase()}
        </Link>
      )}
    </div>
  );
}

// ─── The per-run feed (Running · Failed AI turns) ─────────────────────

function RunFeed({
  input,
  filter,
  onOpen,
}: {
  input: NonNullable<ReturnType<typeof runListInput>>;
  filter: ReturnType<typeof runFilterOf>;
  onOpen: (t: RunTarget) => void;
}) {
  const feed = trpc.runs.list.useInfiniteQuery(
    { ...input, limit: PAGE_SIZE },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      staleTime: 15_000,
      refetchOnWindowFocus: true,
    }
  );
  useEffect(() => {
    if (feed.isError) redirectToLoginIfUnauthorized(feed.error);
  }, [feed.isError, feed.error]);
  const isAuthRedirecting = feed.error?.data?.code === "UNAUTHORIZED";
  const runs = (feed.data?.pages ?? []).flatMap((p) => p.runs);
  const isChat = filter === "chat";

  return (
    <SectionCard
      title={isChat ? "Failed AI turns" : "Running now"}
      hint={
        isChat
          ? "Chat turns that failed — Companion, Discord, external agents"
          : "Every run still going, across rules, templates, sessions and tools"
      }
    >
      {feed.isLoading || isAuthRedirecting ? (
        <ResourceRowSkeleton count={3} />
      ) : feed.isError ? (
        <ResourceRowError
          message="Couldn't load runs."
          onRetry={() => void feed.refetch()}
        />
      ) : runs.length === 0 ? (
        <ResourceRowEmpty
          message={isChat ? "No failed AI turns." : "Nothing is running."}
        />
      ) : (
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {runs.map((run) => (
            <ResourceRow
              key={`${run.flowType}:${run.id}`}
              Icon={kindIcon(run.flowType)}
              primary={run.flowName}
              secondary={`${flowNoun(run.flowType)} · ${runRowSecondary(run)}`}
              status={statusPillFor(run.status) ?? undefined}
              onSelect={() =>
                onOpen({
                  flowType: run.flowType,
                  id: run.id,
                  flowName: run.flowName,
                })
              }
              wrap
            />
          ))}
        </div>
      )}
      {feed.hasNextPage && (
        <div className="px-1 pt-3">
          <Button
            size="sm"
            variant="light"
            radius="md"
            isLoading={feed.isFetchingNextPage}
            onPress={() => void feed.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

"use client";

/**
 * One template (a `playbook`), the one object page — drawn by `/templates/[id]`
 * in the console and by `/open/playbook/:id` in the receiver card
 * (`ObjectFrame`): what it does, how its runs are going, and why they fail.
 *
 * Reads: `playbooks.get` (user-floored), the template's health group
 * (`runs.groups({flowType: "playbook", flowId})` — the same exact counts the
 * list pill reads) and its own runs (`runs.list({flowType: "playbook",
 * flowId})`, keyset-paged), which carry the week's count, the failures and
 * their errors. "Why is it failing?" is read from those runs
 * (`failureExplanation`): the pod exposes no tRPC door that explains a
 * template by id. Every read is protected and user-floored, so a member who
 * was sent the link reads what the pod shows them anywhere. The space's name
 * comes from the reader's own spaces; only a pod admin also asks the
 * all-spaces door (`workspaces.adminListAll` refuses anyone else).
 *
 * No "Run now": `playbooks.run` refuses a template whose required inputs are
 * unanswered, and answering them is a form that lives in the app. Authoring
 * stays there too ("Open in app"). The one act here is Archive, which the pod
 * may route to review — the result is said as it came back.
 */

import { addToast, Button } from "@heroui/react";
import { Play } from "lucide-react";
import { useMemo } from "react";
import { trpc } from "../../../../lib/trpc";
import { formatDate, formatRelative } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import { ExitLink } from "../../../../lib/exit-link";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../(admin)/components/resource-row";
import { statusPillFor } from "../../../(admin)/components/status-tone";
import {
  flowHealthPill,
  runRowSecondary,
} from "../../../(admin)/runs/_lib/run-board";
import {
  executorLabel,
  failureExplanation,
  runsThisWeek,
  stageNames,
  templateSummary,
} from "../../../(admin)/templates/_lib/template-model";
import { couldNotLoad, loadFailure } from "../load-failure";
import { useReauthOnUnauthorized } from "../use-reauth";
import type { ObjectFrame } from "./object-frame";

/** One page of the template's runs — also the window the week is counted over. */
const RUNS_PAGE = 100;
const RECENT = 5;

export function PlaybookObject({
  id,
  frame,
  viewerIsPodAdmin,
  onOpenRun,
  onArchived,
}: {
  id: string;
  frame: ObjectFrame;
  /** Offers only: a pod admin also names spaces they are not a member of. */
  viewerIsPodAdmin: boolean;
  /** Where a frame shows one of its runs (the console's drawer, the run page). */
  onOpenRun: (run: { id: string; flowName: string }) => void;
  /** After an archive lands (not when it was proposed). */
  onArchived?: () => void;
}) {
  const utils = trpc.useUtils();
  const query = trpc.playbooks.get.useQuery({ id }, { retry: false });
  const groups = trpc.runs.groups.useQuery(
    { flowType: "playbook", flowId: id, limit: 1 },
    { enabled: query.isSuccess, retry: false }
  );
  const runs = trpc.runs.list.useInfiniteQuery(
    { flowType: "playbook", flowId: id, limit: RUNS_PAGE },
    {
      enabled: query.isSuccess,
      retry: false,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }
  );
  const workspaceId = query.data?.workspaceId ?? null;
  const mySpaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(workspaceId),
    staleTime: 60_000,
    retry: false,
  });
  const allSpaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    enabled: viewerIsPodAdmin && Boolean(workspaceId),
    staleTime: 60_000,
    retry: false,
  });
  const members = trpc.workspaces.listPodMembers.useQuery(undefined, {
    staleTime: 60_000,
  });
  const archive = trpc.playbooks.archive.useMutation();
  useReauthOnUnauthorized(query.error, runs.error);

  const firstPage = runs.data?.pages[0]?.runs;
  const allRuns = useMemo(
    () => (runs.data?.pages ?? []).flatMap((p) => p.runs),
    [runs.data]
  );

  if (query.isLoading) return frame.loading("Loading template…");
  const playbook = query.data;
  const fail = loadFailure(query.error, "Template");
  if (fail || !playbook) {
    return frame.failure({
      kind: "playbook",
      id,
      failure: fail ?? couldNotLoad("Template"),
    });
  }

  const now = new Date();
  const recent = firstPage ?? [];
  const group = groups.data?.groups[0];
  const week = runsThisWeek(recent, now, RUNS_PAGE);
  const why = failureExplanation(recent.slice(0, 10));
  const latest = recent[0];
  const stages = stageNames(playbook.stages);
  const spaceName = playbook.workspaceId
    ? ([...(mySpaces.data ?? []), ...(allSpaces.data ?? [])].find(
        (s) => s.id === playbook.workspaceId
      )?.name ?? "A space")
    : "All spaces";
  const creator = (members.data ?? []).find((m) => m.id === playbook.createdBy);
  // The group's count is exact over the whole ledger; the loaded rows stand in
  // until it arrives (and when the template has never run, there is no group).
  const runCount = groups.isLoading
    ? runs.isLoading
      ? null
      : allRuns.length
    : (group?.runCount ?? 0);
  const openRun = (runId: string) =>
    onOpenRun({ id: runId, flowName: playbook.name });
  // Named, not inlined: `exit-door.test.ts` reads "Pending: x." as a dead
  // control naming a missing procedure.
  const archiving = archive.isPending;

  const runsBody = (list: typeof allRuns, more: boolean) =>
    runs.isLoading ? (
      <ResourceRowSkeleton count={3} />
    ) : runs.isError ? (
      <ResourceRowError
        message="Its runs couldn’t be loaded."
        onRetry={() => void runs.refetch()}
      />
    ) : list.length === 0 ? (
      <ResourceRowEmpty message="This template hasn’t run yet." />
    ) : (
      <div className="-mx-2 divide-y divide-foreground/[0.05]">
        {list.map((run) => (
          <ResourceRow
            key={run.id}
            Icon={Play}
            primary={formatRelative(run.startedAt, { empty: "Run" })}
            secondary={runRowSecondary(run)}
            status={statusPillFor(run.status) ?? undefined}
            onSelect={() => openRun(run.id)}
            wrap
          />
        ))}
        {more && (
          <div className="px-3 pt-3">
            <Button
              size="sm"
              variant="light"
              radius="md"
              isLoading={runs.isFetchingNextPage}
              onPress={() => void runs.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        )}
      </div>
    );

  return frame.object({
    header: {
      kind: "playbook",
      title: playbook.name,
      summary: templateSummary(playbook.description, playbook.goalTemplate),
      status: flowHealthPill(playbook.status, group),
      breadcrumb: frame.breadcrumb?.(playbook.name),
      primaryAction: (
        <ExitLink
          exit={openIn({ kind: "objectInApp", objectKind: "playbook", id })}
          label="Open in app"
        />
      ),
    },
    facts: [
      { label: "Space", value: spaceName },
      {
        label: "Last run",
        value: runs.isLoading ? (
          <FactSkeleton />
        ) : latest ? (
          `${formatRelative(latest.startedAt)} — ${statusPillFor(latest.status)?.label.toLowerCase() ?? latest.status}`
        ) : (
          "Never"
        ),
      },
      {
        label: "Runs this week",
        value: runs.isLoading ? (
          <FactSkeleton />
        ) : (
          `${week.total}${week.atLeast ? "+" : ""}${week.failed > 0 ? ` · ${week.failed} failed` : ""}`
        ),
      },
      { label: "Executor", value: executorLabel(playbook.executor) },
      {
        label: "Created by",
        value: `${creator?.name ?? creator?.email ?? "Someone"} · ${formatDate(playbook.createdAt)}`,
      },
    ],
    factColumns: 3,
    tabs: [
      {
        key: "overview",
        label: "Overview",
        content: (
          <div className="flex flex-col gap-6">
            {why && (
              <section className="flex flex-col gap-2 rounded-lg bg-status-down/[0.06] px-4 py-3 ring-1 ring-inset ring-status-down/30">
                <h2 className="text-[13px] font-medium text-foreground">
                  Why is it failing?
                </h2>
                <p className="text-[12.5px] leading-relaxed text-foreground/85">
                  {why.sentence}
                </p>
                <div>
                  <Button
                    size="sm"
                    variant="flat"
                    radius="md"
                    onPress={() => openRun(why.latestFailedRunId)}
                  >
                    See the run
                  </Button>
                </div>
              </section>
            )}
            <section className="flex flex-col gap-2">
              <h2 className="text-[13px] font-medium text-foreground">
                Recent runs
              </h2>
              {runsBody(recent.slice(0, RECENT), false)}
            </section>
            {stages.length > 0 && (
              <section className="flex flex-col gap-2">
                <h2 className="text-[13px] font-medium text-foreground">
                  Stages
                </h2>
                <ol className="flex flex-wrap gap-2">
                  {stages.map((name, i) => (
                    <li
                      key={`${name}-${i}`}
                      className="inline-flex items-center gap-1.5 rounded-md bg-foreground/[0.04] px-2.5 py-1 text-[12.5px] text-foreground ring-1 ring-inset ring-foreground/10"
                    >
                      <span className="tabular text-foreground/65">
                        {i + 1}
                      </span>
                      {name}
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        ),
      },
      {
        key: "runs",
        label: runCount === null ? "Runs" : `Runs (${runCount})`,
        content: runsBody(allRuns, runs.hasNextPage ?? false),
      },
    ],
    advanced: {
      ids: [
        { label: "Template id", value: playbook.id },
        ...(playbook.workspaceId
          ? [{ label: "Space id", value: playbook.workspaceId }]
          : []),
      ],
      raw: playbook,
    },
    danger:
      playbook.status === "archived"
        ? []
        : [
            {
              key: "archive",
              label: "Archive template",
              description:
                "When it is no longer a line of work anyone should start.",
              consequence: (
                <>
                  It stops being offered and its schedule and starting rules
                  stop firing. Runs already made, and what they produced, stay.
                  If the pod needs someone to approve it, it is proposed instead
                  and waits in Review.
                </>
              ),
              confirmLabel: "Archive template",
              confirmColor: "warning",
              isPending: archiving,
              onConfirm: async () => {
                try {
                  const out = await archive.mutateAsync({ id });
                  if (out.status === "proposed") {
                    addToast({
                      title: "Archiving was proposed for review.",
                      color: "default",
                    });
                    return;
                  }
                  addToast({ title: "Template archived", color: "default" });
                  await Promise.all([
                    utils.playbooks.get.invalidate({ id }),
                    utils.playbooks.listAllPage.invalidate(),
                    utils.runs.groups.invalidate(),
                  ]);
                  onArchived?.();
                } catch (err) {
                  addToast({
                    title: "Couldn’t archive the template",
                    description: err instanceof Error ? err.message : undefined,
                    color: "danger",
                  });
                  throw err;
                }
              },
            },
          ],
  });
}

/** A fact whose value is still being read. */
function FactSkeleton() {
  return (
    <span
      aria-label="Loading"
      className="inline-block h-3 w-20 rounded bg-foreground/10 shimmer-pulse"
    />
  );
}

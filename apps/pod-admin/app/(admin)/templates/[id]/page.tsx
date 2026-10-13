"use client";

/**
 * `/templates/[id]` — one template (playbook) in the console: what it does,
 * how its runs are going, and why they fail.
 *
 * Reads: `playbooks.get` (user-floored) and the template's own runs
 * (`runs.list({flowType: "playbook", flowId})`, keyset-paged), which carry the
 * week's count, the failures and their errors. "Why is it failing?" is read
 * from those runs (`failureExplanation`): the pod exposes no tRPC door that
 * explains a template by id.
 *
 * No "Run now": `playbooks.run` refuses a template whose required inputs are
 * unanswered, and answering them is a form that lives in the app. Authoring
 * stays there too ("Open in app"). The one act here is Archive, which the pod
 * may route to review — the result is said as it came back.
 */

import { addToast, Button } from "@heroui/react";
import { Play } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { navHref, navLabel } from "../../../../lib/console-nav";
import { trpc } from "../../../../lib/trpc";
import { formatDate, formatRelative } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import { ExitLink } from "../../../../lib/exit-link";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { statusPillFor } from "../../components/status-tone";
import { consoleFrame } from "../../../_lib/object/views/object-frame";
import { couldNotLoad, loadFailure } from "../../../_lib/object/load-failure";
import { useReauthOnUnauthorized } from "../../../_lib/object/use-reauth";
import { RunDrawer, type RunTarget } from "../../runs/_lib/run-drawer";
import { flowHealthPill, runRowSecondary } from "../../runs/_lib/run-board";
import {
  executorLabel,
  failureExplanation,
  groupFactsFromRuns,
  runsThisWeek,
  stageNames,
  templateSummary,
} from "../_lib/template-model";

const FRAME = consoleFrame({
  label: navLabel("templates"),
  href: navHref("templates"),
});
/** One page of the template's runs — also the window the week is counted over. */
const RUNS_PAGE = 100;
const RECENT = 5;

export default function TemplatePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const utils = trpc.useUtils();
  const query = trpc.playbooks.get.useQuery({ id }, { retry: false });
  const runs = trpc.runs.list.useInfiniteQuery(
    { flowType: "playbook", flowId: id, limit: RUNS_PAGE },
    {
      enabled: query.isSuccess,
      retry: false,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }
  );
  const spaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });
  const members = trpc.workspaces.listPodMembers.useQuery(undefined, {
    staleTime: 60_000,
  });
  const archive = trpc.playbooks.archive.useMutation();
  const [target, setTarget] = useState<RunTarget | null>(null);
  useReauthOnUnauthorized(query.error, runs.error);

  const firstPage = runs.data?.pages[0]?.runs;
  const allRuns = useMemo(
    () => (runs.data?.pages ?? []).flatMap((p) => p.runs),
    [runs.data]
  );

  if (query.isLoading) return FRAME.loading("Loading template…");
  const playbook = query.data;
  const fail = loadFailure(query.error, "Template");
  if (fail || !playbook) {
    return FRAME.failure({
      kind: "playbook",
      id,
      failure: fail ?? couldNotLoad("Template"),
    });
  }

  const now = new Date();
  const recent = firstPage ?? [];
  const health = groupFactsFromRuns(recent, now);
  const week = runsThisWeek(recent, now, RUNS_PAGE);
  const why = failureExplanation(recent.slice(0, 10));
  const latest = recent[0];
  const stages = stageNames(playbook.stages);
  const spaceName = playbook.workspaceId
    ? ((spaces.data ?? []).find((s) => s.id === playbook.workspaceId)?.name ??
      "A space")
    : "All spaces";
  const creator = (members.data ?? []).find((m) => m.id === playbook.createdBy);
  const runsLoaded = runs.isLoading ? null : allRuns.length;
  const openRun = (runId: string, flowName: string) =>
    setTarget({ flowType: "playbook", id: runId, flowName });
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
            onSelect={() => openRun(run.id, run.flowName)}
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

  return (
    <>
      {FRAME.object({
        header: {
          kind: "playbook",
          title: playbook.name,
          summary: templateSummary(playbook.description, playbook.goalTemplate),
          status: flowHealthPill(playbook.status, health),
          breadcrumb: FRAME.breadcrumb?.(playbook.name),
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
                        onPress={() =>
                          openRun(why.latestFailedRunId, playbook.name)
                        }
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
            label:
              runsLoaded === null
                ? "Runs"
                : `Runs (${runsLoaded}${runs.hasNextPage ? "+" : ""})`,
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
                      stop firing. Runs already made, and what they produced,
                      stay. If the pod needs someone to approve it, it is
                      proposed instead and waits in Review.
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
                      addToast({
                        title: "Template archived",
                        color: "default",
                      });
                      await Promise.all([
                        utils.playbooks.listAllPage.invalidate(),
                        utils.runs.groups.invalidate(),
                      ]);
                      router.push(navHref("templates"));
                    } catch (err) {
                      addToast({
                        title: "Couldn’t archive the template",
                        description:
                          err instanceof Error ? err.message : undefined,
                        color: "danger",
                      });
                      throw err;
                    }
                  },
                },
              ],
      })}
      <RunDrawer target={target} onClose={() => setTarget(null)} />
    </>
  );
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

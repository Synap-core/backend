"use client";

/**
 * A tool page's runs: "Running now" (only while something runs) and
 * "History" (its last runs, "Show all" into Runs filtered to the tool). Drawn
 * by the capability page and a code skill's page; an instruction skill does
 * not run, and its page says so instead (`skill-object.tsx`).
 *
 * Reads, all user-floored: `runs.list` with the tool lens (the actions' runs)
 * and, for a capability's rules and templates, `runs.recentByFlows`. A read
 * that fails says so in its section: never an empty history, never "nothing
 * is running". Shaping in `tool-runs-model.ts`.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { trpc } from "../../../../lib/trpc";
import { formatRelative } from "../../../../lib/format";
import { navHref } from "../../../../lib/console-nav";
import { openIn } from "../../../../lib/open-in";
import { useT } from "../../../../lib/i18n/locale-provider";
import { kindIcon } from "../kind-icon";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../../(admin)/components/resource-row";
import { useConsoleRole } from "../../../(admin)/components/side-nav-role";
import { statusPillFor } from "../../../(admin)/components/status-tone";
import {
  flowNoun,
  runRowSecondary,
} from "../../../(admin)/runs/_lib/run-board";
import { TOOLS_CATALOGS } from "../../../(admin)/tools/_lib/copy";
import { runningNow } from "../../../(admin)/tools/_lib/tool-runs-model";

/** Runs the History section shows before "Show all". */
const HISTORY = 10;
const READ = { retry: false, staleTime: 15_000 } as const;

export type ToolLens = { capabilityId: string } | { skillId: string };

export function ToolRuns({
  tool,
  flows = [],
  actionLabel,
}: {
  tool: ToolLens;
  /** A capability's rules and templates; their live runs are "running" too. */
  flows?: ReadonlyArray<{
    flowType: "automation" | "playbook";
    flowId: string;
    name: string;
  }>;
  /** An action run's name in words (`actionLabelFor`). */
  actionLabel: (flowName: string) => string;
}) {
  const t = useT(TOOLS_CATALOGS);
  const router = useRouter();
  const role = useConsoleRole();
  const scope =
    "capabilityId" in tool
      ? { capabilityId: tool.capabilityId }
      : { skillId: tool.skillId };
  const history = trpc.runs.list.useQuery(
    { flowType: "capability", scope, limit: HISTORY },
    READ
  );
  const runningActions = trpc.runs.list.useQuery(
    { flowType: "capability", scope, status: "running", limit: 20 },
    READ
  );
  const flowRuns = trpc.runs.recentByFlows.useQuery(
    {
      flows: flows
        .slice(0, 100)
        .map(({ flowType, flowId }) => ({ flowType, flowId })),
      perFlowLimit: 5,
    },
    { ...READ, enabled: flows.length > 0 }
  );

  const openRun = (flowType: string, id: string) =>
    router.push(
      openIn({ kind: "object", objectKind: "run", id, params: { flowType } })
        .href
    );

  const runningFailed =
    runningActions.isError || (flows.length > 0 && flowRuns.isError);
  const running = runningNow({
    actionRuns: runningActions.data?.runs ?? [],
    flows,
    histories: flowRuns.data?.histories ?? [],
    actionLabel,
  });
  const runs = history.data?.runs ?? [];
  const showAll =
    role === "admin"
      ? navHref(
          "runs",
          "capabilityId" in tool
            ? { capability: tool.capabilityId }
            : { skill: tool.skillId }
        )
      : null;

  return (
    <>
      {runningFailed ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-medium text-foreground">
            {t("running.title")}
          </h2>
          <ResourceRowError
            message={t("running.failed")}
            onRetry={() => {
              void runningActions.refetch();
              if (flows.length > 0) void flowRuns.refetch();
            }}
          />
        </section>
      ) : running.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-medium text-foreground">
            {t("running.title")}
          </h2>
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
            {running.map((r) => (
              <ResourceRow
                key={r.key}
                Icon={kindIcon(r.flowType)}
                primary={r.name || flowNoun(r.flowType)}
                secondary={[
                  flowNoun(r.flowType),
                  t("running.started", { when: formatRelative(r.startedAt) }),
                ].join(" · ")}
                status={statusPillFor("running") ?? undefined}
                onSelect={() => openRun(r.flowType, r.id)}
                wrap
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-medium text-foreground">
          {t("history.title")}
        </h2>
        {history.isLoading ? (
          <ResourceRowSkeleton count={3} />
        ) : history.isError ? (
          <ResourceRowError
            message={t("history.failed")}
            onRetry={() => void history.refetch()}
          />
        ) : runs.length === 0 ? (
          <ResourceRowEmpty message={t("history.empty")} />
        ) : (
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
            {runs.map((run) => (
              <ResourceRow
                key={run.id}
                Icon={Play}
                primary={actionLabel(run.flowName)}
                secondary={runRowSecondary(run)}
                status={statusPillFor(run.status) ?? undefined}
                onSelect={() => openRun(run.flowType, run.id)}
                wrap
              />
            ))}
          </div>
        )}
        {showAll && runs.length > 0 && (
          <Link
            href={showAll}
            className="inline-flex min-h-10 items-center self-start rounded-sm px-1 text-[12.5px] text-foreground/70 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {t("history.showAll")}
          </Link>
        )}
      </section>
    </>
  );
}

"use client";

/**
 * Processes — every line of work on the pod (a playbook seen whole), and how
 * it is doing. Replaces Templates (`/templates` redirects here).
 *
 * Rows are `playbooks.processes()`, the pod's ONE process list
 * (`@synap-core/types/processes` `ProcessSummary`: health, run counts, needs),
 * archived ones left out. A row opens `/processes/[id]`; authoring stays in
 * the desktop app. The automations that belong to no process (the read's
 * `automationsOutsideProcess`, membership decided once on the pod) are
 * counted under the list, a door to Automations (`/rules?process=outside`),
 * the one list of every automation, folded into this nav item.
 * `?focus=<playbookId>` is received by the row wrappers.
 */

import { Workflow, Building2, Globe } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import {
  PROCESS_HEALTH_STATES,
  processHealthNeedsAttention,
  type ProcessHealthState,
} from "@synap-core/types/processes";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { navHref, navLabel } from "../../../lib/console-nav";
import { trpc } from "../../../lib/trpc";
import { openIn } from "../../../lib/open-in";
import { ExitLink } from "../../../lib/exit-link";
import { useConsoleLocale, useT } from "../../../lib/i18n/locale-provider";
import { PageFallback, PageShell } from "../components/page-header";
import {
  FilterChip,
  ListCard,
  ListToolbar,
  PageHeader,
} from "../components/list-page";
import { statusOption } from "../components/filter-options";
import { ResourceRow } from "../components/resource-row";
import { useFocusRow } from "../components/use-focus-row";
import { filterBySearch } from "../components/list-search";
import { ListSearch, useDebouncedQuery } from "../components/list-search-box";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { CATALOGS } from "./_lib/copy";
import { countDoors, processHealthPill, type Words } from "./_lib/process-page";

/** The space filter's id for a process that belongs to no space. */
const ALL_SPACES = "all-spaces";
/** "Needs attention" (the leaf's attention states), or one health state. */
type HealthFilter = "attention" | ProcessHealthState;

export default function ProcessesPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <ProcessesInner />
    </Suspense>
  );
}

function ProcessesInner() {
  const router = useRouter();
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const say = (w: Words) => t(w.key, w.params as never);
  const search = useDebouncedQuery();
  const [space, setSpace] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthFilter | null>(null);
  const list = trpc.playbooks.processes.useQuery({}, { staleTime: 30_000 });
  const spaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });
  useReauthOnUnauthorized(list.error);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  const rows = useMemo(
    () => (list.data?.processes ?? []).filter((p) => p.status !== "archived"),
    [list.data]
  );
  // null = that read failed (never "none"); undefined = still loading.
  const outside = list.data?.automationsOutsideProcess;
  const spaceName = useMemo(() => {
    const byId = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (id: string | null) =>
      id ? (byId.get(id) ?? t("list.aSpace")) : t("list.allSpaces");
  }, [spaces.data, t]);

  const shownRows = useMemo(
    () =>
      filterBySearch(
        rows.filter((p) => {
          if (space !== null && (p.workspaceId ?? ALL_SPACES) !== space)
            return false;
          if (health === "attention")
            return processHealthNeedsAttention(p.health);
          return health === null || p.health.state === health;
        }),
        search.query,
        (p) => [p.name, spaceName(p.workspaceId)]
      ),
    [rows, search.query, spaceName, space, health]
  );
  const spaceOptions = useMemo(() => {
    const ids = [...new Set(rows.map((p) => p.workspaceId ?? ALL_SPACES))];
    return ids.map((id) => ({
      id,
      label: id === ALL_SPACES ? t("list.allSpaces") : spaceName(id),
      icon: id === ALL_SPACES ? Globe : Building2,
      count: rows.filter((p) => (p.workspaceId ?? ALL_SPACES) === id).length,
    }));
  }, [rows, spaceName, t]);

  const loading = list.isLoading || isAuthRedirecting;
  useFocusRow({ ready: !loading });

  return (
    <PageShell>
      <PageHeader
        title={navLabel("processes")}
        description={t("list.description")}
        actions={
          <ExitLink
            exit={openIn({ kind: "app", appId: "playbooks" })}
            label={t("list.create")}
          />
        }
      />

      <ListToolbar
        search={
          <ListSearch
            value={search.input}
            onChange={search.setInput}
            label={t("list.search")}
            className=""
          />
        }
        filters={
          <>
            <FilterChip
              label={resolveObjectNoun("workspace")}
              allLabel={t("list.filter.allSpaces")}
              value={space}
              onChange={setSpace}
              options={spaceOptions}
            />
            <FilterChip<HealthFilter>
              label={t("list.filter.health")}
              allLabel={t("list.filter.anyHealth")}
              value={health}
              onChange={setHealth}
              options={[
                statusOption("attention", {
                  label: t("list.filter.attention"),
                }),
                // The states the rows are in, in the leaf's order.
                ...PROCESS_HEALTH_STATES.filter((s) =>
                  rows.some((p) => p.health.state === s)
                ).map((s) => statusOption(s)),
              ]}
            />
          </>
        }
      />

      <ListCard
        title={navLabel("processes")}
        hint={t("list.hint")}
        count={shownRows.length}
        loading={loading}
        isError={list.isError}
        onRetry={() => void list.refetch()}
        errorMessage={t("list.failed")}
        rowCount={shownRows.length}
        emptyMessage={rows.length === 0 ? t("list.empty") : t("list.noMatch")}
        skeletonRows={4}
        footer={
          loading || list.isError ? undefined : outside === null ? (
            <p className="px-1 pt-3 text-[12px] text-foreground/65">
              {t("list.outsideFailed")}
            </p>
          ) : outside && outside.length > 0 ? (
            <p className="flex flex-wrap items-center gap-2 px-1 pt-3 text-[12px] text-foreground/65">
              {t("list.outside", { n: outside.length })}
              <Link
                href={navHref("rules", { process: "outside" })}
                className="text-foreground/85 underline-offset-2 hover:underline"
              >
                {t("list.outsideDoor")}
              </Link>
            </p>
          ) : undefined
        }
      >
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {shownRows.map((p) => {
            const week = countDoors(p.counts);
            const secondary = [
              spaceName(p.workspaceId),
              t("list.steps", { n: p.stepCount }),
              ...week.doors.map((d) => say(d.words)),
            ].join(" · ");
            return (
              <div
                key={p.id}
                data-row-id={p.id}
                className="rounded-md transition-shadow"
              >
                <ResourceRow
                  Icon={Workflow}
                  primary={p.name}
                  secondary={secondary}
                  status={processHealthPill(p.health, locale)}
                  onSelect={() =>
                    router.push(
                      `${navHref("processes")}/${encodeURIComponent(p.id)}`
                    )
                  }
                  wrap
                />
              </div>
            );
          })}
        </div>
      </ListCard>
    </PageShell>
  );
}

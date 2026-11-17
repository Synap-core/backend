"use client";

/**
 * Processes — every line of work on the pod (a playbook seen whole), and how
 * it is doing. Replaces Templates (`/templates` redirects here).
 *
 * Rows are `playbooks.processes()`, the pod's ONE process list
 * (`@synap-core/types/processes` `ProcessSummary`: health, run counts, needs),
 * archived ones left out. A row opens `/processes/[id]`; authoring stays in
 * the desktop app. Automations, folded into this nav item, are always one
 * door away ("All automations" in the header); the ACTIVE ones that belong
 * to no process (the read's `automationsOutsideProcess`, membership decided
 * once on the pod) are counted under the list, a door to
 * `/rules?process=outside`, which opens on the same Active filter.
 * Filters live in the URL (`?space=`, `?health=`), like Automations.
 * `?focus=<playbookId>` is received by the row wrappers.
 */

import { Workflow, Building2, Circle, Globe } from "lucide-react";
import { Button } from "@heroui/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import {
  PROCESS_HEALTH_REASONS,
  processHealthNeedsAttention,
  type ProcessHealthReason,
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
import { ruleIsActive } from "../rules/_lib/rule-rows";
import { CATALOGS } from "./_lib/copy";
import {
  countDoors,
  healthFilterOptions,
  processHealthPill,
  sayWith,
  spaceWords,
} from "./_lib/process-page";

/** The space filter's id for a process that belongs to no space. */
const NO_SPACE = "no-space";
/** "Needs attention" (the leaf's attention states), or one health reason. */
type HealthFilter = "attention" | ProcessHealthReason;

function healthFilterOf(raw: string | null): HealthFilter | null {
  if (raw === "attention") return raw;
  return (PROCESS_HEALTH_REASONS as readonly string[]).includes(raw ?? "")
    ? (raw as ProcessHealthReason)
    : null;
}

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
  const say = sayWith(t);
  const search = useDebouncedQuery();
  const searchParams = useSearchParams();
  const space = searchParams.get("space");
  const health = healthFilterOf(searchParams.get("health"));
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
  // null = that read failed (never "none"); undefined = still loading. The
  // footer counts the active ones: /rules opens on its Active filter.
  const outside = list.data?.automationsOutsideProcess;
  const outsideActive = outside?.filter(ruleIsActive).length ?? 0;
  const spaceName = useMemo(() => {
    const byId = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (id: string | null) => {
      const w = spaceWords(id, byId, spaces.isError);
      return typeof w === "string" ? w : t(w.key);
    };
  }, [spaces.data, spaces.isError, t]);

  const shownRows = useMemo(
    () =>
      filterBySearch(
        rows.filter((p) => {
          if (space !== null && (p.workspaceId ?? NO_SPACE) !== space)
            return false;
          if (health === "attention")
            return processHealthNeedsAttention(p.health);
          return health === null || p.health.reason === health;
        }),
        search.query,
        (p) => [p.name, spaceName(p.workspaceId)]
      ),
    [rows, search.query, spaceName, space, health]
  );
  const spaceOptions = useMemo(() => {
    const ids = [...new Set(rows.map((p) => p.workspaceId ?? NO_SPACE))];
    return ids.map((id) => ({
      id,
      label: spaceName(id === NO_SPACE ? null : id),
      icon: id === NO_SPACE ? Globe : Building2,
      count: rows.filter((p) => (p.workspaceId ?? NO_SPACE) === id).length,
    }));
  }, [rows, spaceName]);

  const loading = list.isLoading || isAuthRedirecting;
  useFocusRow({ ready: !loading });

  return (
    <PageShell>
      <PageHeader
        title={navLabel("processes")}
        description={t("list.description")}
        actions={
          <>
            <Button
              as={Link}
              href={navHref("rules")}
              size="sm"
              variant="flat"
              radius="md"
            >
              {t("list.allAutomations")}
            </Button>
            <ExitLink
              exit={openIn({ kind: "app", appId: "playbooks" })}
              label={t("list.create")}
            />
          </>
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
              param="space"
              value={space}
              options={spaceOptions}
            />
            <FilterChip<HealthFilter>
              label={t("list.filter.health")}
              allLabel={t("list.filter.anyHealth")}
              param="health"
              value={health}
              options={[
                statusOption("attention", {
                  label: t("list.filter.attention"),
                }),
                // The healths the rows are in, in the pill's own words.
                ...healthFilterOptions(
                  rows.map((p) => p.health),
                  locale
                ).map((o) => ({ ...o, icon: Circle })),
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
          ) : outsideActive > 0 ? (
            <p className="flex flex-wrap items-center gap-2 px-1 pt-3 text-[12px] text-foreground/65">
              {t("list.outside", { n: outsideActive })}
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
              // A count that could not be read is said, never dropped.
              ...(week.unmeasured ? [t("count.unmeasured")] : []),
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

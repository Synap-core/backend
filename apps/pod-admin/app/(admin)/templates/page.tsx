"use client";

/**
 * Templates — the reusable lines of work (playbooks) and whether their runs
 * go through.
 *
 * Rows are `playbooks.listAllPage` (user-floored, D1a; cursor "Load more"),
 * archived ones left out, joined on `flowId` with the `runs.groups` playbook
 * rows for health. A row opens `/templates/[id]`; authoring stays in the
 * desktop app. `?focus=<playbookId>` is received by the row wrappers.
 */

import { Button } from "@heroui/react";
import { BookOpen } from "lucide-react";
import { Suspense, useEffect, useMemo } from "react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
import { openIn } from "../../../lib/open-in";
import { ExitLink } from "../../../lib/exit-link";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { ResponsiveTable } from "../components/responsive-table";
import { StatusPill } from "../components/status-pill";
import { SectionCard } from "../components/section-card";
import { useFocusRow } from "../components/use-focus-row";
import { filterBySearch } from "../components/list-search";
import { ListSearch, useDebouncedQuery } from "../components/list-search-box";
import { useT } from "../../../lib/i18n/locale-provider";
import { en, fr } from "../components/copy";
import { useDrainPages } from "../../../lib/use-drain-pages";
import { flowHealthPill, flowHealthSentence } from "../runs/_lib/run-board";
import {
  RunHealthLegend,
  RunHealthStrip,
  ServesGoal,
} from "../components/run-health-cells";
import {
  runHealthCell,
  servesGoalCell,
  servesGoalText,
} from "../runs/_lib/run-health-view";

const CATALOGS = { en, fr };

const TITLE = "Templates";
const DESCRIPTION =
  "Reusable lines of work, and whether their runs go through.";
/** Health is joined over this many pages of `runs.groups` (100 each). */
const MAX_GROUP_PAGES = 20;

export default function TemplatesPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <TemplatesInner />
    </Suspense>
  );
}

function TemplatesInner() {
  const t = useT(CATALOGS);
  const search = useDebouncedQuery();
  const list = trpc.playbooks.listAllPage.useInfiniteQuery(
    { limit: 50 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      staleTime: 30_000,
    }
  );
  const groups = trpc.runs.groups.useInfiniteQuery(
    { flowType: "playbook", limit: 100 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      staleTime: 30_000,
    }
  );
  useDrainPages(groups, MAX_GROUP_PAGES);
  const spaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });

  useEffect(() => {
    if (list.isError) redirectToLoginIfUnauthorized(list.error);
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  const rows = useMemo(
    () =>
      (list.data?.pages ?? [])
        .flatMap((p) => p.playbooks)
        .filter((p) => p.status !== "archived"),
    [list.data]
  );
  const groupById = useMemo(
    () =>
      new Map(
        (groups.data?.pages ?? [])
          .flatMap((p) => p.groups)
          .map((g) => [g.flowId, g])
      ),
    [groups.data]
  );
  const spaceName = useMemo(() => {
    const byId = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));
    return (id: string | null) =>
      id ? (byId.get(id) ?? "A space") : "All spaces";
  }, [spaces.data]);

  const shownRows = useMemo(
    () =>
      filterBySearch(rows, search.query, (p) => [
        p.name,
        spaceName(p.workspaceId),
      ]),
    [rows, search.query, spaceName]
  );

  const loading = list.isLoading || isAuthRedirecting;
  useFocusRow({ ready: !loading });

  return (
    <PageShell>
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={
          <ExitLink
            exit={openIn({ kind: "app", appId: "playbooks" })}
            label="Create in app"
          />
        }
      />

      <SectionCard
        title="Templates"
        hint="Newest first. Archived templates are left out."
      >
        {loading ? (
          <ResourceRowSkeleton count={4} />
        ) : list.isError ? (
          <ResourceRowError
            message="Couldn't load templates."
            onRetry={() => void list.refetch()}
          />
        ) : rows.length === 0 ? (
          <ResourceRowEmpty message="No templates yet. Templates are made in the Synap app, or saved from a session that went well." />
        ) : (
          <>
            <ListSearch
              value={search.input}
              onChange={search.setInput}
              label={t("listSearch.templates")}
            />
            {list.hasNextPage && search.query && (
              <p className="mb-2 text-[12px] text-foreground/65">
                {t("listSearch.partial.templates", { n: rows.length })}
              </p>
            )}
            {shownRows.length === 0 ? (
              <ResourceRowEmpty
                message={t("listSearch.none", { query: search.query })}
              />
            ) : (
              <>
                <ResponsiveTable
                  ariaLabel="Templates"
                  rows={shownRows}
                  rowKey={(p) => p.id}
                  rowId={(p) => p.id}
                  href={(p) => `/templates/${encodeURIComponent(p.id)}`}
                  name={{
                    header: "Name",
                    width: "minmax(0,2fr)",
                    label: (p) => p.name,
                  }}
                  columns={[
                    {
                      header: "Space",
                      width: "minmax(0,1fr)",
                      cell: (p) => spaceName(p.workspaceId),
                    },
                    {
                      header: "Serves goal",
                      width: "minmax(0,1.2fr)",
                      className: "min-w-0",
                      cell: (p) => <ServesGoal goals={p.servesGoals} />,
                    },
                    {
                      header: "Health",
                      width: "minmax(0,1.1fr)",
                      className: "min-w-0",
                      cell: (p) => <RunHealthStrip health={p.runHealth} />,
                    },
                    {
                      header: "Last run",
                      width: "minmax(0,0.9fr)",
                      cell: (p) => {
                        const g = groupById.get(p.id);
                        return g ? formatRelative(g.latestStartedAt) : "never";
                      },
                    },
                    {
                      header: "Status",
                      width: "minmax(0,1fr)",
                      className: "min-w-0",
                      cell: (p) => {
                        const pill = flowHealthPill(
                          p.status,
                          groupById.get(p.id)
                        );
                        return (
                          <StatusPill kind={pill.kind} label={pill.label} />
                        );
                      },
                    },
                  ]}
                  phone={(p) => {
                    const g = groupById.get(p.id);
                    return {
                      Icon: BookOpen,
                      secondary: [
                        spaceName(p.workspaceId),
                        g
                          ? `${flowHealthSentence({ ...g, flowType: "playbook" })} · last ran ${formatRelative(g.latestStartedAt)}`
                          : "Never ran",
                        servesGoalText(servesGoalCell(p.servesGoals)),
                        runHealthCell(p.runHealth).sentence,
                      ].join(" · "),
                      status: flowHealthPill(p.status, g),
                    };
                  }}
                />
                <RunHealthLegend />
              </>
            )}
          </>
        )}
        {list.hasNextPage && (
          <div className="px-1 pt-3">
            <Button
              size="sm"
              variant="light"
              radius="md"
              isLoading={list.isFetchingNextPage}
              onPress={() => void list.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        )}
        {groups.isError && !loading && (
          <p className="px-1 pt-3 text-[12px] text-foreground/65">
            Run health couldn’t be loaded, so templates show without it.
          </p>
        )}
      </SectionCard>
    </PageShell>
  );
}

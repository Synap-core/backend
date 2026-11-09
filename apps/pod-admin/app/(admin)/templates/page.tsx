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

import { addToast, Button } from "@heroui/react";
import { Archive, BookOpen, Building2, Globe } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
import { openIn } from "../../../lib/open-in";
import { ExitLink } from "../../../lib/exit-link";
import { PageFallback, PageShell } from "../components/page-header";
import {
  FilterChip,
  ListCard,
  ListToolbar,
  PageHeader,
} from "../components/list-page";
import { statusOption } from "../components/filter-options";
import { ConfirmModal } from "../components/confirm-modal";
import { ResourceRow } from "../components/resource-row";
import { useFocusRow } from "../components/use-focus-row";
import { filterBySearch } from "../components/list-search";
import { ListSearch, useDebouncedQuery } from "../components/list-search-box";
import { useT } from "../../../lib/i18n/locale-provider";
import { en, fr } from "../components/copy";
import { useDrainPages } from "../../../lib/use-drain-pages";
import {
  flowHealthPill,
  flowHealthSentence,
  flowIsFailing,
} from "../runs/_lib/run-board";

const CATALOGS = { en, fr };

/** The space filter's id for a template that belongs to no space. */
const ALL_SPACES = "all-spaces";
type HealthFilter = "failing" | "never-ran";

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
  const router = useRouter();
  const t = useT(CATALOGS);
  const search = useDebouncedQuery();
  const utils = trpc.useUtils();
  const [space, setSpace] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthFilter | null>(null);
  const [toArchive, setToArchive] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const archive = trpc.playbooks.archive.useMutation();
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
      filterBySearch(
        rows.filter((p) => {
          if (space !== null && (p.workspaceId ?? ALL_SPACES) !== space)
            return false;
          const g = groupById.get(p.id);
          if (health === "failing") return g ? flowIsFailing(g) : false;
          if (health === "never-ran") return !g;
          return true;
        }),
        search.query,
        (p) => [p.name, spaceName(p.workspaceId)]
      ),
    [rows, search.query, spaceName, space, health, groupById]
  );
  const spaceOptions = useMemo(() => {
    const ids = [...new Set(rows.map((p) => p.workspaceId ?? ALL_SPACES))];
    return ids.map((id) => ({
      id,
      label: id === ALL_SPACES ? "All spaces" : spaceName(id),
      icon: id === ALL_SPACES ? Globe : Building2,
      count: rows.filter((p) => (p.workspaceId ?? ALL_SPACES) === id).length,
    }));
  }, [rows, spaceName]);

  async function confirmArchive() {
    if (!toArchive) return;
    try {
      const out = await archive.mutateAsync({ id: toArchive.id });
      addToast({
        title:
          out.status === "proposed"
            ? "Archiving was proposed for review."
            : "Template archived",
        color: "default",
      });
      if (out.status !== "proposed")
        await Promise.all([
          utils.playbooks.listAllPage.invalidate(),
          utils.runs.groups.invalidate(),
        ]);
      setToArchive(null);
    } catch (err) {
      addToast({
        title: "Couldn’t archive the template",
        description: err instanceof Error ? err.message : undefined,
        color: "danger",
      });
      setToArchive(null);
    }
  }

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

      <ListToolbar
        search={
          <ListSearch
            value={search.input}
            onChange={search.setInput}
            label={t("listSearch.templates")}
            className=""
          />
        }
        filters={
          <>
            <FilterChip
              label="Space"
              allLabel="All spaces"
              value={space}
              onChange={setSpace}
              options={spaceOptions}
            />
            <FilterChip<HealthFilter>
              label="Health"
              allLabel="Any health"
              value={health}
              onChange={setHealth}
              options={[statusOption("failing"), statusOption("never-ran")]}
            />
          </>
        }
      />

      <ListCard
        title="Templates"
        hint="Newest first. Archived templates are left out."
        count={shownRows.length}
        loading={loading}
        isError={list.isError}
        onRetry={() => void list.refetch()}
        errorMessage="Couldn't load templates."
        rowCount={shownRows.length}
        emptyMessage={
          rows.length === 0
            ? "No templates yet. Templates are made in the Synap app, or saved from a session that went well."
            : search.query
              ? t("listSearch.none", { query: search.query })
              : "No template matches these filters."
        }
        skeletonRows={4}
        pagination={{
          kind: "more",
          hasNext: list.hasNextPage ?? false,
          isFetchingNext: list.isFetchingNextPage,
          onLoadMore: () => void list.fetchNextPage(),
        }}
        footer={
          <>
            {list.hasNextPage && (search.query || space || health) && (
              <p className="mt-2 text-[12px] text-foreground/65">
                {t("listSearch.partial.templates", { n: rows.length })}
              </p>
            )}
            {groups.isError && !loading && (
              <p className="px-1 pt-3 text-[12px] text-foreground/65">
                Run health couldn’t be loaded, so templates show without it.
              </p>
            )}
          </>
        }
      >
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {shownRows.map((p) => {
            const g = groupById.get(p.id);
            const secondary = [
              spaceName(p.workspaceId),
              g
                ? `${flowHealthSentence({ ...g, flowType: "playbook" })} · last ran ${formatRelative(g.latestStartedAt)}`
                : "Never ran",
            ].join(" · ");
            return (
              <div
                key={p.id}
                data-row-id={p.id}
                className="rounded-md transition-shadow"
              >
                <ResourceRow
                  Icon={BookOpen}
                  primary={p.name}
                  secondary={secondary}
                  status={flowHealthPill(p.status, g)}
                  onSelect={() =>
                    router.push(`/templates/${encodeURIComponent(p.id)}`)
                  }
                  actions={
                    <Button
                      size="sm"
                      variant="light"
                      radius="md"
                      startContent={<Archive className="h-3.5 w-3.5" />}
                      aria-label={`Archive ${p.name}`}
                      onPress={() => setToArchive({ id: p.id, name: p.name })}
                    >
                      Archive
                    </Button>
                  }
                  wrap
                />
              </div>
            );
          })}
        </div>
      </ListCard>

      <ConfirmModal
        isOpen={toArchive !== null}
        onClose={() => setToArchive(null)}
        onConfirm={() => void confirmArchive()}
        title={`Archive “${toArchive?.name ?? ""}”?`}
        consequence={
          <>
            It stops being offered and its schedule and starting rules stop
            firing. Runs already made, and what they produced, stay. If the pod
            needs someone to approve it, it is proposed instead and waits in
            Review.
          </>
        }
        confirmLabel="Archive template"
        confirmColor="warning"
        isPending={archive.isPending}
      />
    </PageShell>
  );
}

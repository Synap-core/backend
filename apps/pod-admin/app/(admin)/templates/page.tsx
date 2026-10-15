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
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo } from "react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
import { openIn } from "../../../lib/open-in";
import { ExitLink } from "../../../lib/exit-link";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import { useFocusRow } from "../components/use-focus-row";
import { useDrainPages } from "../../../lib/use-drain-pages";
import { flowHealthPill, flowHealthSentence } from "../runs/_lib/run-board";

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
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
            {rows.map((p) => {
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
                    wrap
                  />
                </div>
              );
            })}
          </div>
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

"use client";

/**
 * "Show all" for a site: every record (`/sites/[projectId]/records`, walked
 * page by page with the status read's cursor) or every chart
 * (`/sites/[projectId]/charts`, the status read lists up to its own cap and
 * says when there are more). The scope is in the address.
 */

import { useState } from "react";
import { Button } from "@heroui/react";
import { trpc } from "../../../../lib/trpc";
import { navHref, siteHref } from "../../../../lib/console-nav";
import { useReauthOnUnauthorized } from "../../../_lib/object/use-reauth";
import {
  Breadcrumbs,
  type ObjectCrumb,
} from "../../../_lib/object/object-header";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import {
  ChartRow,
  RecordRow,
  useSiteItemActions,
  type SiteChart,
  type SiteRecord,
} from "./site-items";

/** Records per page of the walk (the server clamps at its own bound). */
const RECORDS_PAGE = 100;

function useCrumbs(projectId: string, leaf: string): ObjectCrumb[] {
  const list = trpc.shares.listSites.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  const name =
    list.data?.sites.find((s) => s.projectId === projectId)?.projectName ??
    "Site";
  return [
    { label: "Sites", href: navHref("sites") },
    { label: name, href: siteHref(projectId) },
    { label: leaf },
  ];
}

export function SiteAllRecords({ projectId }: { projectId: string }) {
  const crumbs = useCrumbs(projectId, "Records");
  const utils = trpc.useUtils();
  const first = trpc.shares.siteStatus.useQuery(
    { projectId, limit: RECORDS_PAGE },
    { retry: false }
  );
  useReauthOnUnauthorized(first.error);
  // The pages after the first, walked with the status read's own cursor.
  const [more, setMore] = useState<SiteRecord[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  // A row's verb re-reads the first page; the later ones start again from it.
  const items = useSiteItemActions(first.data?.siteId ?? "", () => {
    setMore([]);
    setCursor(undefined);
  });
  const site = first.data ?? null;
  const next =
    cursor === undefined ? (site?.membersNextCursor ?? null) : cursor;
  const records = [...((site?.members ?? []) as SiteRecord[]), ...more];

  async function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await utils.shares.siteStatus.fetch({
        projectId,
        limit: RECORDS_PAGE,
        cursor: next,
      });
      setMore((m) => [...m, ...((page?.members ?? []) as SiteRecord[])]);
      setCursor(page?.membersNextCursor ?? null);
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs crumbs={crumbs} />
      <SectionCard
        title="Records"
        hint={site ? `${records.length} of ${site.membersTotal}` : undefined}
      >
        {first.isLoading ? (
          <ResourceRowSkeleton count={4} />
        ) : first.isError ? (
          <ResourceRowError
            message="Couldn't read this site."
            onRetry={() => void first.refetch()}
          />
        ) : !site ? (
          <ResourceRowEmpty message="This project has no site." />
        ) : records.length === 0 ? (
          <ResourceRowEmpty message="Nothing published here yet." />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="-mx-2 divide-y divide-foreground/[0.05]">
              {records.map((r) => (
                <RecordRow
                  key={r.entityId}
                  record={r}
                  siteLive={site.live}
                  actions={items}
                />
              ))}
            </div>
            {moreFailed ? (
              <ResourceRowError
                message="Couldn't read the next records."
                onRetry={() => void loadMore()}
              />
            ) : next ? (
              <div>
                <Button
                  size="sm"
                  radius="md"
                  variant="flat"
                  isLoading={loadingMore}
                  onPress={() => void loadMore()}
                >
                  Show more
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

export function SiteAllCharts({ projectId }: { projectId: string }) {
  const crumbs = useCrumbs(projectId, "Charts");
  const status = trpc.shares.siteStatus.useQuery(
    { projectId, limit: 1 },
    { retry: false }
  );
  useReauthOnUnauthorized(status.error);
  const site = status.data ?? null;
  const items = useSiteItemActions(site?.siteId ?? "");
  const charts = (site?.charts ?? []) as SiteChart[];

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs crumbs={crumbs} />
      <SectionCard
        title="Charts"
        hint={
          site
            ? site.chartsTotal > charts.length
              ? `The ${charts.length} newest of ${site.chartsTotal}`
              : String(site.chartsTotal)
            : undefined
        }
      >
        {status.isLoading ? (
          <ResourceRowSkeleton count={4} />
        ) : status.isError ? (
          <ResourceRowError
            message="Couldn't read this site."
            onRetry={() => void status.refetch()}
          />
        ) : !site ? (
          <ResourceRowEmpty message="This project has no site." />
        ) : charts.length === 0 ? (
          <ResourceRowEmpty message="This site publishes no chart." />
        ) : (
          <div className="-mx-2 divide-y divide-foreground/[0.05]">
            {charts.map((c) => (
              <ChartRow
                key={c.cellInstanceId}
                chart={c}
                siteLive={site.live}
                actions={items}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

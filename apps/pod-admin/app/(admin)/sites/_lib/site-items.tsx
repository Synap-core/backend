"use client";

/**
 * What a site publishes, one row each: its RECORDS (`siteStatus.members`)
 * and its CHARTS (`siteStatus.charts`), with the verbs each row takes.
 * Shared by the site page (first {@link SITE_PAGE_ITEMS}) and its "Show all"
 * pages. Marks come from the one site model (`memberMark`, `chartMark`).
 *
 *   record: Publish again (changed or taken off) · Take off
 *   chart:  Refresh (a published snapshot) · Publish again (taken off) · Take off
 *
 * Taken-off rows stay listed, marked "Taken off" (open question 3).
 */

import {
  Button,
  Chip,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  addToast,
} from "@heroui/react";
import {
  ArrowUpRight,
  ChartColumn,
  FileText,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatDate } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import { ResourceRow } from "../../components/resource-row";
import {
  chartMark,
  chartModeLabel,
  collectionLabel,
  memberMark,
} from "./site-model";

export interface SiteRecord {
  entityId: string;
  title: string | null;
  collection: string | null;
  state: string;
  publishedAt: Date | string | null;
  live: boolean;
  stale: boolean;
}

export interface SiteChart {
  cellInstanceId: string;
  title: string | null;
  mode: "snapshot" | "live" | null;
  slug: string | null;
  state: string;
  publishedAt: Date | string | null;
  capturedAt: string | null;
  live: boolean;
}

/** The site's item verbs, each scoped to the row it runs for. */
export function useSiteItemActions(siteId: string, onChanged?: () => void) {
  const utils = trpc.useUtils();
  const refresh = () => {
    onChanged?.();
    void utils.shares.siteStatus.invalidate();
    void utils.shares.listSites.invalidate();
  };
  const failed =
    (title: string) =>
    (err: { message: string; data?: { code?: string | null } | null }) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({ title, description: err.message, color: "danger" });
    };

  const publishRecord = trpc.shares.publishToSite.useMutation({
    onSuccess: (res) => {
      refresh();
      if (res.status === "proposed") {
        addToast({ title: "Sent to Requests", color: "default" });
      } else if (res.skipped.length > 0) {
        addToast({
          title: "Not published",
          description: res.skipped[0]?.reason,
          color: "warning",
        });
      } else {
        addToast({ title: "Published again", color: "default" });
      }
    },
    onError: failed("Couldn't publish it"),
  });
  const takeOffRecord = trpc.shares.unpublishFromSite.useMutation({
    onSuccess: () => {
      refresh();
      addToast({ title: "Taken off the site", color: "default" });
    },
    onError: failed("Couldn't take it off"),
  });
  const publishChart = trpc.shares.publishChartsToSite.useMutation({
    onSuccess: (res) => {
      refresh();
      if (res.status === "proposed") {
        addToast({ title: "Sent to Requests", color: "default" });
      } else if (res.skipped.length > 0) {
        addToast({
          title: "Not published",
          description: res.skipped[0]?.reason,
          color: "warning",
        });
      } else {
        addToast({ title: "Chart published", color: "default" });
      }
    },
    onError: failed("Couldn't publish the chart"),
  });
  const takeOffChart = trpc.shares.unpublishChartsFromSite.useMutation({
    onSuccess: () => {
      refresh();
      addToast({ title: "Chart taken off the site", color: "default" });
    },
    onError: failed("Couldn't take the chart off"),
  });

  const recordPending = (id: string) =>
    (publishRecord.isPending &&
      publishRecord.variables?.entityIds.includes(id)) ||
    (takeOffRecord.isPending &&
      (takeOffRecord.variables?.entityIds ?? []).includes(id));
  const chartPending = (id: string) =>
    (publishChart.isPending &&
      publishChart.variables?.charts.some((c) => c.cellInstanceId === id)) ||
    (takeOffChart.isPending &&
      takeOffChart.variables?.cellInstanceIds.includes(id));

  return {
    publishRecord: (id: string) =>
      publishRecord.mutate({ siteId, entityIds: [id] }),
    takeOffRecord: (id: string) =>
      takeOffRecord.mutate({ siteId, entityIds: [id] }),
    /** A snapshot is refreshed, a taken-off chart comes back: same mode, same address. */
    publishChart: (c: SiteChart) =>
      c.mode
        ? publishChart.mutate({
            siteId,
            charts: [
              { cellInstanceId: c.cellInstanceId, mode: c.mode, slug: c.slug },
            ],
          })
        : undefined,
    takeOffChart: (id: string) =>
      takeOffChart.mutate({ siteId, cellInstanceIds: [id] }),
    recordPending,
    chartPending,
  };
}

export type SiteItemActions = ReturnType<typeof useSiteItemActions>;

function RowMenu({
  label,
  items,
}: {
  label: string;
  items: Array<{
    key: string;
    label: string;
    onPress?: () => void;
    href?: string;
    danger?: boolean;
  }>;
}) {
  return (
    <Dropdown>
      <DropdownTrigger>
        <Button
          isIconOnly
          size="sm"
          variant="light"
          radius="full"
          aria-label={label}
          className="text-foreground/55"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownTrigger>
      <DropdownMenu aria-label={label}>
        {items.map((item) => (
          <DropdownItem
            key={item.key}
            color={item.danger ? "danger" : "default"}
            href={item.href}
            onPress={item.onPress}
            endContent={
              item.href ? <ArrowUpRight className="h-3.5 w-3.5" /> : undefined
            }
          >
            {item.label}
          </DropdownItem>
        ))}
      </DropdownMenu>
    </Dropdown>
  );
}

export function RecordRow({
  record,
  siteLive,
  actions,
}: {
  record: SiteRecord;
  siteLive: boolean;
  actions: SiteItemActions;
}) {
  const router = useRouter();
  const mark = memberMark(record, siteLive);
  const takenOff = record.state === "draft";
  const pending = actions.recordPending(record.entityId);
  const secondary = [
    collectionLabel(record.collection),
    takenOff
      ? "taken off"
      : record.publishedAt
        ? `published ${formatDate(record.publishedAt)}`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const open = openIn({
    kind: "object",
    objectKind: "entity",
    id: record.entityId,
  });
  return (
    <ResourceRow
      Icon={FileText}
      wrap
      primary={record.title ?? "Untitled record"}
      secondary={secondary}
      status={mark ?? undefined}
      onSelect={() => router.push(open.href)}
      actions={
        <div className="flex items-center gap-1">
          {record.stale && !takenOff && (
            <Button
              size="sm"
              radius="md"
              variant="flat"
              isLoading={pending}
              onPress={() => actions.publishRecord(record.entityId)}
            >
              Publish again
            </Button>
          )}
          <RowMenu
            label="Record actions"
            items={
              takenOff
                ? [
                    {
                      key: "publish",
                      label: "Publish again",
                      onPress: () => actions.publishRecord(record.entityId),
                    },
                  ]
                : [
                    {
                      key: "take-off",
                      label: "Take off",
                      danger: true,
                      onPress: () => actions.takeOffRecord(record.entityId),
                    },
                  ]
            }
          />
        </div>
      }
    />
  );
}

export function ChartRow({
  chart,
  siteLive,
  actions,
}: {
  chart: SiteChart;
  siteLive: boolean;
  actions: SiteItemActions;
}) {
  const mark = chartMark(chart, siteLive);
  const takenOff = chart.state === "draft";
  const pending = actions.chartPending(chart.cellInstanceId);
  const secondary = takenOff
    ? "taken off"
    : chart.mode === "snapshot"
      ? chart.capturedAt
        ? `captured ${formatDate(chart.capturedAt)}`
        : "snapshot"
      : chart.mode === "live"
        ? "re-read for visitors at most once a minute"
        : "its stored chart no longer reads: publish it again";
  const open = openIn({
    kind: "object",
    objectKind: "cell",
    id: chart.cellInstanceId,
  });
  return (
    <ResourceRow
      Icon={ChartColumn}
      wrap
      primary={chart.title ?? "Untitled chart"}
      secondary={secondary}
      status={mark ?? undefined}
      actions={
        <div className="flex items-center gap-1">
          <Chip size="sm" radius="sm" variant="flat">
            {chartModeLabel(chart.mode)}
          </Chip>
          {!takenOff && chart.mode === "snapshot" && (
            <Button
              size="sm"
              radius="md"
              variant="flat"
              isLoading={pending}
              startContent={
                pending ? undefined : <RefreshCw className="h-3.5 w-3.5" />
              }
              onPress={() => actions.publishChart(chart)}
            >
              Refresh
            </Button>
          )}
          <RowMenu
            label="Chart actions"
            items={[
              ...(takenOff && chart.mode
                ? [
                    {
                      key: "publish",
                      label: "Publish again",
                      onPress: () => actions.publishChart(chart),
                    },
                  ]
                : []),
              { key: "open", label: "Open in Synap", href: open.href },
              ...(!takenOff
                ? [
                    {
                      key: "take-off",
                      label: "Take off",
                      danger: true,
                      onPress: () => actions.takeOffChart(chart.cellInstanceId),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      }
    />
  );
}

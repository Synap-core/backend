"use client";

/**
 * Connectors tab — pod-wide aggregate / health-grid view.
 *
 * Pod Admin's Connectors tab is the META picture: how many providers are
 * connected on this pod, how many of those are healthy, plus a per-workspace
 * grid that points operators back into Studio when something needs hands-on
 * editing. Per-workspace connector configuration lives in Studio's
 * `IntegrationsTab` — Pod Admin does not duplicate it.
 *
 * Sections:
 *   1. Health grid — one card per Nango provider type (aggregate)
 *   2. Pod-level source configs — `sourceConfigs.list` (admin-scope)
 *   3. Per-workspace connector grid — denser table, click → side drawer
 *
 * If a procedure is missing or the data shape doesn't fit, we render a
 * graceful stub with a clearly labelled TODO. Section 1 should always
 * work because we derive aggregates from any connectors list query.
 */

import { Button } from "@heroui/react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Layers,
  Plug,
  RefreshCw,
  Rss,
  Server,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { trpc } from "../../../lib/trpc";
import { DetailDrawer } from "../components/detail-drawer";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import type { StatusKind } from "../components/status-pill";
import { StatusPill } from "../components/status-pill";
import { useFocusRow } from "../components/use-focus-row";

// ─── Page ─────────────────────────────────────────────────────────────

export default function ConnectorsPage() {
  // Connectors uses `useSearchParams` indirectly via `useFocusRow` — wrap
  // in Suspense per Next 16's App Router contract.
  return (
    <Suspense fallback={<ConnectorsFallback />}>
      <ConnectorsInner />
    </Suspense>
  );
}

function ConnectorsFallback() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Connectors
        </h1>
      </header>
      <div className="h-9 w-full max-w-md rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}

function ConnectorsInner() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Connectors
        </h1>
        <p className="text-[13px] text-foreground/55">
          External services connected to this pod. Per-workspace configuration
          happens in Studio — Pod Admin shows the aggregate health.
        </p>
      </header>

      <div className="flex flex-col gap-6">
        <ProviderHealthGrid />
        <PodLevelConnectorsSection />
        <PerWorkspaceGridSection />
      </div>
    </div>
  );
}

// ─── 1. Provider health grid ──────────────────────────────────────────

/**
 * `connectors.providers` returns the providers list straight from the
 * Control Plane (Nango). Each row carries `connected: boolean` plus
 * (potentially) per-connection status. We aggregate to one card per
 * provider type — "✓ N healthy / M total".
 *
 * If the procedure throws (e.g. no CP configured) we surface that as a
 * single banner rather than spamming an error per card.
 */

interface CpProviderRow {
  providerId?: string;
  providerKey?: string;
  name?: string;
  displayName?: string;
  logo?: string;
  iconUrl?: string;
  connected?: boolean;
  status?: string;
  connectionId?: string | null;
  // Some flows return a list of connections per provider rather than a
  // single boolean — we fan in either shape.
  connections?: Array<{ status?: string; lastSyncedAt?: string | Date }>;
}

interface ProviderAggregate {
  providerId: string;
  displayName: string;
  logo: string | null;
  total: number;
  healthy: number;
  failing: number;
}

function ProviderHealthGrid() {
  const providersQuery = trpc.connectors.providers.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });

  const aggregates = useMemo<ProviderAggregate[]>(() => {
    if (!providersQuery.data) return [];
    const raw = (providersQuery.data.providers ?? []) as CpProviderRow[];
    const byId = new Map<string, ProviderAggregate>();

    for (const p of raw) {
      const id = p.providerId ?? p.providerKey ?? p.name ?? "unknown";
      const display = p.displayName ?? p.name ?? id;
      const logo = p.logo ?? p.iconUrl ?? null;

      const conns =
        p.connections ?? (p.connected ? [{ status: p.status }] : []);
      const total = conns.length;
      const healthy = conns.filter(
        (c) => !c.status || c.status === "ok" || c.status === "active"
      ).length;
      const failing = total - healthy;

      const existing = byId.get(id);
      if (existing) {
        existing.total += total;
        existing.healthy += healthy;
        existing.failing += failing;
      } else {
        byId.set(id, {
          providerId: id,
          displayName: display,
          logo,
          total,
          healthy,
          failing,
        });
      }
    }

    return [...byId.values()].sort((a, b) => b.total - a.total);
  }, [providersQuery.data]);

  return (
    <SectionCard
      title="Provider health"
      hint="Aggregate per Nango provider across all workspaces"
      actions={
        providersQuery.data ? (
          <span className="text-[11px] tabular text-foreground/55">
            {aggregates.length} providers
          </span>
        ) : null
      }
    >
      {providersQuery.isLoading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <ProviderCardSkeleton key={i} />
          ))}
        </div>
      ) : providersQuery.isError ? (
        <ErrorBanner
          message={
            providersQuery.error?.message ??
            "Couldn't load providers from Control Plane."
          }
          hint="If this pod has no CP configured, provider listings are unavailable."
        />
      ) : aggregates.length === 0 ? (
        <ResourceRowEmpty message="No providers wired into this pod yet." />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {aggregates.map((a) => (
            <ProviderCard key={a.providerId} agg={a} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function ProviderCard({ agg }: { agg: ProviderAggregate }) {
  const allHealthy = agg.failing === 0 && agg.total > 0;
  const someFailing = agg.failing > 0;
  const empty = agg.total === 0;

  let statusKind: StatusKind = "healthy";
  let statusLabel = `${agg.healthy} / ${agg.total} healthy`;
  if (empty) {
    statusKind = "unknown";
    statusLabel = "No connections";
  } else if (someFailing) {
    statusKind = agg.healthy === 0 ? "down" : "stale";
    statusLabel = `${agg.failing} failing`;
  }

  // Provider initials for the logo fallback (first two letters, uppercase).
  const initials = agg.displayName
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div
      className={[
        "flex flex-col gap-2 p-3 rounded-medium",
        "ring-1 ring-inset ring-foreground/10",
        "bg-foreground/[0.02]",
      ].join(" ")}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-[10px] font-semibold tracking-tight text-foreground/85"
          style={
            agg.logo
              ? { backgroundImage: `url(${agg.logo})`, backgroundSize: "cover" }
              : undefined
          }
        >
          {!agg.logo && (initials || "?")}
        </span>
        <span className="truncate text-[13px] font-medium text-foreground">
          {agg.displayName}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] text-foreground/55">
          {agg.total} {agg.total === 1 ? "connection" : "connections"}
        </span>
        <StatusPill kind={statusKind} label={statusLabel} />
      </div>
      {allHealthy && (
        <span className="inline-flex items-center gap-1 text-[11px] text-status-healthy">
          <CheckCircle2 className="h-3 w-3" strokeWidth={2} aria-hidden />
          All connections healthy
        </span>
      )}
      {someFailing && (
        <span className="inline-flex items-center gap-1 text-[11px] text-status-down">
          <AlertTriangle className="h-3 w-3" strokeWidth={2} aria-hidden />
          {agg.failing} {agg.failing === 1 ? "connection" : "connections"}{" "}
          failing
        </span>
      )}
    </div>
  );
}

function ProviderCardSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]">
      <div className="flex items-center gap-2">
        <div className="h-7 w-7 shrink-0 rounded-md bg-foreground/10 shimmer-pulse" />
        <div className="h-3 w-1/2 rounded bg-foreground/10 shimmer-pulse" />
      </div>
      <div className="h-2.5 w-3/4 rounded bg-foreground/[0.07] shimmer-pulse" />
      <div className="h-5 w-20 rounded bg-foreground/[0.07] shimmer-pulse" />
    </div>
  );
}

// ─── 2. Pod-level connectors (source_configs) ─────────────────────────

/**
 * Source configs are pod-admin-scope: each row is a provider config the
 * operator owns at the pod level (RSS feeds, ICS calendars, generic HTTP
 * pollers, …). They MAY be workspace-scoped (`workspaceId`) or pod-wide
 * (`workspaceId = null`).
 *
 * Mutations (re-auth, edit) deep-link to Studio per the same "Pod Admin
 * is meta, Studio is detail" rule.
 */

interface SourceConfigRow {
  id: string;
  providerType: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  workspaceId?: string | null;
  config?: Record<string, unknown> | null;
}

function PodLevelConnectorsSection() {
  const query = trpc.sourceConfigs.list.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });

  const rows = (query.data ?? []) as SourceConfigRow[];

  return (
    <SectionCard
      title="Pod-level connectors"
      hint="Source configs the operator owns directly (RSS, ICS, HTTP pollers)"
      actions={
        rows.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {rows.length} configured
          </span>
        ) : null
      }
    >
      {query.isLoading ? (
        <ResourceRowSkeleton count={3} />
      ) : query.isError ? (
        <ErrorBanner
          message={
            query.error?.message ?? "Couldn't load pod-level connectors."
          }
        />
      ) : rows.length === 0 ? (
        <ResourceRowEmpty message="No pod-level source configs yet." />
      ) : (
        <div className="-mx-2">
          {rows.map((row) => (
            <ResourceRow
              key={row.id}
              Icon={iconForProvider(row.providerType)}
              primary={row.name}
              secondary={[
                row.providerType,
                row.workspaceId
                  ? `workspace ${row.workspaceId.slice(0, 8)}`
                  : "Pod-level",
                row.description,
              ]
                .filter(Boolean)
                .join(" · ")}
              status={
                row.enabled
                  ? { kind: "healthy", label: "Enabled" }
                  : { kind: "unknown", label: "Disabled" }
              }
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function iconForProvider(providerType: string) {
  const t = providerType.toLowerCase();
  if (t.includes("rss") || t.includes("feed")) return Rss;
  if (t.includes("http") || t.includes("api")) return Cloud;
  if (t.includes("calendar") || t.includes("ics")) return Layers;
  return Server;
}

// ─── 3. Per-workspace connector grid ─────────────────────────────────

/**
 * Aggregate every connector instance into one row per (workspace,
 * provider) pair. Today the list query we have access to is `feeds.list`
 * (subscriptions, scoped to caller). For a true cross-workspace grid we
 * would need a `connectors.allConnections` admin endpoint — not present
 * yet — so we render what we can and label the gap.
 *
 * Click → opens a side Drawer with the row's detail and a deep link out
 * to Studio.
 */

interface FeedRow {
  id: string;
  feedId?: string | null;
  workspaceId?: string | null;
  status: string;
  lastFetchedAt?: Date | string | null;
  errorMessage?: string | null;
  // Joined config columns from listSubscriptionsWithConfig (nested as
  // `sourceConfig.{name,providerType}` in the returned row).
  sourceConfig?: {
    id?: string;
    name?: string | null;
    providerType?: string | null;
    enabled?: boolean | null;
  } | null;
}

function PerWorkspaceGridSection() {
  const [selected, setSelected] = useState<FeedRow | null>(null);

  // The closest cross-workspace signal we have today is the feeds
  // subscription list. It's caller-scoped (one userId) — for a real
  // pod-wide grid we'd need an admin variant. Flagged below.
  const query = trpc.feeds.list.useQuery(
    { limit: 100, offset: 0 },
    { staleTime: 60_000, retry: false }
  );

  const rows = (query.data ?? []) as unknown as FeedRow[];

  // ?focus=<feedId> from ⌘K or Overview alerts (sync errors). Open the
  // drawer once the matching row is rendered.
  const focusId = useFocusRow({ ready: !query.isLoading });
  useEffect(() => {
    if (!focusId || selected) return;
    const found = rows.find((r) => r.id === focusId);
    if (found) setSelected(found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, rows]);

  return (
    <>
      <SectionCard
        title="Per-workspace connector grid"
        hint="Connectors grouped by workspace · click a row for detail"
        actions={
          <span className="text-[11px] tabular text-foreground/55">
            {rows.length} rows
          </span>
        }
      >
        {query.isLoading ? (
          <ResourceRowSkeleton count={4} />
        ) : query.isError ? (
          <ErrorBanner
            message={
              query.error?.message ?? "Couldn't load per-workspace connectors."
            }
          />
        ) : rows.length === 0 ? (
          <div className="flex flex-col gap-2 px-3 py-6 text-center">
            <p className="text-[12.5px] text-foreground/55">
              No connector rows.
            </p>
            <p className="text-[11px] text-foreground/40">
              {/* TODO(phase-C): add `trpc.connectors.allConnections`
                  (admin-scope) so we can render every connector across all
                  workspaces here. Today we list `feeds.list` rows for the
                  caller only. */}
              Pod-wide listing requires `connectors.allConnections` (TODO).
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-medium ring-1 ring-inset ring-foreground/10">
            <table className="w-full border-collapse text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-foreground/[0.05] bg-foreground/[0.02]">
                  <Th>Workspace</Th>
                  <Th>Provider</Th>
                  <Th>Status</Th>
                  <Th>Last sync</Th>
                  <Th className="w-16">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    data-row-id={row.id}
                    onClick={() => setSelected(row)}
                    className={[
                      "cursor-pointer border-b border-foreground/[0.05]",
                      "transition-colors hover:bg-content2/50",
                      "last:border-b-0",
                    ].join(" ")}
                  >
                    <Td className="text-foreground">
                      {row.workspaceId
                        ? row.workspaceId.slice(0, 8)
                        : "Pod-wide"}
                    </Td>
                    <Td className="text-foreground/85">
                      <span className="inline-flex items-center gap-1.5">
                        {row.sourceConfig?.providerType ?? "—"}
                        {row.sourceConfig?.name && (
                          <span className="text-foreground/45">
                            {row.sourceConfig.name}
                          </span>
                        )}
                      </span>
                    </Td>
                    <Td>
                      <StatusPill
                        kind={feedStatusKind(row.status)}
                        label={row.status}
                      />
                    </Td>
                    <Td className="text-foreground/55 tabular">
                      {row.lastFetchedAt
                        ? formatRelative(new Date(row.lastFetchedAt))
                        : "—"}
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="light"
                        radius="md"
                        onPress={() => setSelected(row)}
                        endContent={<ExternalLink className="h-3 w-3" />}
                        className="text-foreground/55"
                      >
                        Open
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <ConnectorDetailDrawer row={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function ConnectorDetailDrawer({
  row,
  onClose,
}: {
  row: FeedRow | null;
  onClose: () => void;
}) {
  const studioHref = row?.workspaceId
    ? `/studio/workspaces/${row.workspaceId}/settings/integrations`
    : "/studio/settings/integrations";

  return (
    <DetailDrawer
      isOpen={!!row}
      onClose={onClose}
      title={
        row?.sourceConfig?.name ??
        row?.sourceConfig?.providerType ??
        "Connector"
      }
      subtitle={
        row
          ? row.workspaceId
            ? `workspace ${row.workspaceId.slice(0, 8)}`
            : "Pod-wide"
          : undefined
      }
      footer={
        row ? (
          <>
            <Button
              as={Link}
              href={studioHref}
              size="sm"
              variant="solid"
              color="primary"
              radius="md"
              endContent={<ExternalLink className="h-3 w-3" />}
            >
              Open in Studio
            </Button>
            <Button
              size="sm"
              variant="flat"
              radius="md"
              startContent={<RefreshCw className="h-3 w-3" />}
              isDisabled
            >
              Re-authenticate
            </Button>
            <Button
              size="sm"
              variant="light"
              radius="md"
              startContent={<Trash2 className="h-3 w-3" />}
              isDisabled
              className="ml-auto text-status-down"
            >
              Remove
            </Button>
          </>
        ) : null
      }
    >
      {row ? (
        <div className="flex flex-col gap-4">
          <DrawerField label="Status">
            <StatusPill kind={feedStatusKind(row.status)} label={row.status} />
          </DrawerField>
          <DrawerField label="Provider">
            <span className="text-[12.5px] text-foreground/85">
              {row.sourceConfig?.providerType ?? "—"}
            </span>
          </DrawerField>
          <DrawerField label="Last fetched">
            <span className="text-[12.5px] text-foreground/85 tabular">
              {row.lastFetchedAt
                ? new Date(row.lastFetchedAt).toLocaleString()
                : "Never"}
            </span>
          </DrawerField>
          {row.errorMessage && (
            <DrawerField label="Last error">
              <p className="text-[11.5px] text-status-down break-words">
                {row.errorMessage}
              </p>
            </DrawerField>
          )}
          <DrawerField label="Recent events">
            {/* TODO(phase-C): wire `trpc.feeds.recentItems` (or an
                equivalent connector-event log) and render the last 5
                events with timestamps. */}
            <p className="text-[11px] text-foreground/45">
              Recent event timeline requires a connector-event log endpoint
              (TODO).
            </p>
          </DrawerField>
        </div>
      ) : null}
    </DetailDrawer>
  );
}

function DrawerField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] font-medium uppercase tracking-wide text-foreground/45">
        {label}
      </span>
      {children}
    </div>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────

function Th({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <th
      className={[
        "px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide text-foreground/55",
        className ?? "",
      ].join(" ")}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <td className={["px-3 py-2 align-middle", className ?? ""].join(" ")}>
      {children}
    </td>
  );
}

function ErrorBanner({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-medium ring-1 ring-inset ring-status-down/30 bg-status-down/[0.06] px-3 py-2.5">
      <AlertTriangle
        className="h-3.5 w-3.5 shrink-0 text-status-down"
        strokeWidth={2}
        aria-hidden
      />
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] font-medium text-status-down">
          {message}
        </span>
        {hint && <span className="text-[11px] text-foreground/55">{hint}</span>}
      </div>
    </div>
  );
}

function feedStatusKind(status: string): StatusKind {
  switch (status) {
    case "active":
    case "ok":
      return "healthy";
    case "paused":
      return "stale";
    case "error":
    case "failed":
      return "down";
    default:
      return "unknown";
  }
}

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Suppress unused-import warnings for icons referenced by lookup only.
void Plug;
void Building2;

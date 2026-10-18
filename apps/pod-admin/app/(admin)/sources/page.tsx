"use client";

/**
 * Sources — pod-wide aggregate / health-grid view of the pod's connectors.
 *
 * The Sources page is the META picture: how many providers are
 * connected on this pod, how many of those are healthy, plus a per-space
 * grid that hands operators off to the app when something needs
 * hands-on editing. Connector configuration lives in the app's
 * Settings → Connectors — the console does not duplicate it.
 *
 * Sections:
 *   1. Health grid — one card per Nango provider type (aggregate)
 *   2. Pod-level source configs — `sourceConfigs.list` (admin-scope)
 *   3. Per-space connector grid — denser table, click → side drawer
 *
 * Section 1 should always work because we derive aggregates from any
 * connectors list query.
 */

import { Button } from "@heroui/react";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Layers,
  Plug,
  Rss,
  Server,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { navLabel } from "../../../lib/console-nav";
import { openIn } from "../../../lib/open-in";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import { DetailDrawer } from "../components/detail-drawer";
import { HandoffCard } from "../components/handoff-card";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import type { StatusKind } from "../components/status-pill";
import { StatusPill } from "../components/status-pill";
import { useFocusRow } from "../components/use-focus-row";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { FactsGrid } from "../../_lib/object/facts-grid";
import { formatRelative, formatTimestamp } from "../../../lib/format";

// ─── Page ─────────────────────────────────────────────────────────────

export default function SourcesPage() {
  // Sources uses `useSearchParams` indirectly via `useFocusRow` — wrap
  // in Suspense per Next 16's App Router contract.
  return (
    <Suspense fallback={<PageFallback />}>
      <SourcesInner />
    </Suspense>
  );
}

function SourcesInner() {
  return (
    <PageShell>
      <PageHeader
        title={navLabel("sources")}
        description="External services connected to this pod. Each space's connections are set up in the app; this page shows their health across the pod."
      />

      <div className="flex flex-col gap-6">
        <ProviderHealthGrid />
        <PodLevelConnectorsSection />
        <PerWorkspaceGridSection />
      </div>
    </PageShell>
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

  useEffect(() => {
    if (providersQuery.isError) {
      redirectToLoginIfUnauthorized(providersQuery.error);
    }
  }, [providersQuery.isError, providersQuery.error]);
  const isAuthRedirecting = providersQuery.error?.data?.code === "UNAUTHORIZED";

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
      hint="Connections per provider, across all spaces"
      actions={
        providersQuery.data ? (
          <span className="text-[11px] tabular text-foreground/65">
            {aggregates.length} providers
          </span>
        ) : null
      }
    >
      {providersQuery.isLoading || isAuthRedirecting ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <ProviderCardSkeleton key={i} />
          ))}
        </div>
      ) : providersQuery.isError ? (
        <ErrorBanner
          message="Couldn't load providers from the Control Plane."
          hint="If this pod isn't linked to a Control Plane, provider listings are unavailable."
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
        <span className="text-[11.5px] text-foreground/65">
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
 * Mutations (re-auth, edit) are not the console's: they hand off to the
 * app — the console is the overview, the app is the detail.
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

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const rows = (query.data ?? []) as SourceConfigRow[];

  return (
    <SectionCard
      title="Pod-level connectors"
      hint="Source configs the operator owns directly (RSS, ICS, HTTP pollers)"
      actions={
        rows.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/65">
            {rows.length} configured
          </span>
        ) : null
      }
    >
      {query.isLoading || isAuthRedirecting ? (
        <ResourceRowSkeleton count={3} />
      ) : query.isError ? (
        <ErrorBanner message="Couldn't load pod-level connectors." />
      ) : rows.length === 0 ? (
        <ResourceRowEmpty message="No pod-level source configs yet." />
      ) : (
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {rows.map((row) => (
            <ResourceRow
              key={row.id}
              Icon={iconForProvider(row.providerType)}
              primary={row.name}
              secondary={[
                row.providerType,
                row.workspaceId
                  ? `space ${row.workspaceId.slice(0, 8)}`
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
 * Pod-wide grid of every connector instance, grouped by workspace.
 * Backed by `trpc.connectors.allConnections` (admin-scope).
 *
 * Click → opens a side Drawer with the row's detail and a handoff out to
 * the desktop app.
 */

interface ConnectionRow {
  connectionId: string;
  providerId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  accountEmail: string | null;
  status: string;
  lastSyncedAt: Date | string;
  createdAt: Date | string;
}

function PerWorkspaceGridSection() {
  const [selected, setSelected] = useState<ConnectionRow | null>(null);

  const query = trpc.connectors.allConnections.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const rows = (query.data ?? []) as ConnectionRow[];

  // ?focus=<connectionId> from ⌘K.
  const focusId = useFocusRow({ ready: !query.isLoading });
  useEffect(() => {
    if (!focusId || selected) return;
    const found = rows.find((r) => r.connectionId === focusId);
    if (found) setSelected(found);
  }, [focusId, rows]);

  // Group by workspaceName (falls back to workspaceId or "Pod-wide").
  const grouped = useMemo(() => {
    const out = new Map<string, ConnectionRow[]>();
    for (const row of rows) {
      const key =
        row.workspaceName ??
        (row.workspaceId ? row.workspaceId.slice(0, 8) : "Pod-wide");
      const bucket = out.get(key) ?? [];
      bucket.push(row);
      out.set(key, bucket);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  return (
    <>
      <SectionCard
        title="Connectors by space"
        hint="Grouped by space · open a row for detail"
        actions={
          <span className="text-[11px] tabular text-foreground/65">
            {rows.length} rows
          </span>
        }
      >
        {query.isLoading || isAuthRedirecting ? (
          <ResourceRowSkeleton count={4} />
        ) : query.isError ? (
          <ErrorBanner message="Couldn't load connectors." />
        ) : rows.length === 0 ? (
          <ResourceRowEmpty message="No connectors configured anywhere on this pod." />
        ) : (
          <div className="flex flex-col gap-3">
            {grouped.map(([workspaceLabel, bucket]) => (
              <div
                key={workspaceLabel}
                className="overflow-x-auto rounded-medium ring-1 ring-inset ring-foreground/10"
              >
                <div className="flex items-center justify-between gap-3 border-b border-foreground/[0.05] bg-foreground/[0.03] px-3 py-2">
                  <span className="text-[12px] font-medium text-foreground">
                    {workspaceLabel}
                  </span>
                  <span className="text-[10.5px] tabular text-foreground/65">
                    {bucket.length} connector
                    {bucket.length === 1 ? "" : "s"}
                  </span>
                </div>
                <table className="w-full border-collapse text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-foreground/[0.05] bg-foreground/[0.02]">
                      <Th>Provider</Th>
                      <Th>Account</Th>
                      <Th>Status</Th>
                      <Th>Last sync</Th>
                      <Th className="w-16">Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {bucket.map((row) => (
                      <tr
                        key={row.connectionId}
                        data-row-id={row.connectionId}
                        onClick={() => setSelected(row)}
                        className={[
                          "cursor-pointer border-b border-foreground/[0.05]",
                          "transition-colors hover:bg-content2/50",
                          "last:border-b-0",
                        ].join(" ")}
                      >
                        <Td className="text-foreground/85">{row.providerId}</Td>
                        <Td className="text-foreground/65">
                          {row.accountEmail ?? "—"}
                        </Td>
                        <Td>
                          <StatusPill
                            kind={feedStatusKind(row.status)}
                            label={resolveStatusLabel(row.status)}
                          />
                        </Td>
                        <Td className="text-foreground/65 tabular">
                          {formatRelative(row.lastSyncedAt)}
                        </Td>
                        <Td>
                          <Button
                            size="sm"
                            variant="light"
                            radius="md"
                            onPress={() => setSelected(row)}
                            className="text-foreground/65"
                          >
                            Open
                          </Button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
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
  row: ConnectionRow | null;
  onClose: () => void;
}) {
  return (
    <DetailDrawer
      isOpen={!!row}
      onClose={onClose}
      title={row?.providerId ?? "Connector"}
      subtitle={
        row
          ? (row.workspaceName ??
            (row.workspaceId
              ? `space ${row.workspaceId.slice(0, 8)}`
              : "Pod-wide"))
          : undefined
      }
    >
      {row ? (
        <div className="flex flex-col gap-4">
          <FactsGrid
            columns={2}
            facts={[
              {
                label: "Status",
                value: (
                  <StatusPill
                    kind={feedStatusKind(row.status)}
                    label={resolveStatusLabel(row.status)}
                  />
                ),
              },
              { label: "Provider", value: row.providerId },
              { label: "Account", value: row.accountEmail ?? "—" },
              {
                label: "Last synced",
                value: row.lastSyncedAt
                  ? formatTimestamp(row.lastSyncedAt)
                  : "Never",
              },
              { label: "Created", value: formatTimestamp(row.createdAt) },
              { label: "Connection ID", value: row.connectionId, mono: true },
            ]}
          />

          {/* Re-auth and removal hold the OAuth grant itself — they belong
              wherever the connection was made, not on a read-only health
              console. This replaces three exits that all failed: two buttons
              permanently disabled behind "Pending: connectors.*", and an
              "Open in Studio" link to a /studio route pod-admin never served. */}
          <HandoffCard
            icon={Plug}
            title="Connector settings live in the app"
            body="Re-authenticating a provider or removing a connection happens where the connection was made. Pod Console reports health across the whole pod; it does not hold the grant."
            exit={openIn({ kind: "settings", section: "connectors" })}
            cta="Open Connectors settings"
          />
        </div>
      ) : null}
    </DetailDrawer>
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
        "px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide text-foreground/65",
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
        {hint && <span className="text-[11px] text-foreground/65">{hint}</span>}
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

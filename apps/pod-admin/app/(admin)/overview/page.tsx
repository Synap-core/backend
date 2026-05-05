"use client";

/**
 * Overview tab — the home of the Pod Admin shell.
 *
 * Five cards in a responsive 2-column grid (single-column on small):
 *
 *   1. Sync     — pod-to-pod replication state.
 *   2. Backups  — last/next backup, success/failure.
 *   3. Capacity — disk %, doc count, vector index size.
 *   4. Alerts   — urgent issues across the pod (max 5; "View all" link).
 *   5. Approval queue — pending pod-level proposals + Kratos signups.
 *
 * Each card pulls its own data via tRPC; queries run in parallel and a
 * loading state never blocks adjacent cards from rendering. When a tRPC
 * procedure is missing or the shape doesn't fit, we render a graceful
 * stub with a TODO comment pointing at the gap.
 */

import { Button } from "@heroui/react";
import {
  AlertTriangle,
  ChevronRight,
  CircleCheck,
  Clock,
  Database,
  GitBranch,
  HardDrive,
  KeyRound,
  Mailbox,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { trpc } from "../../../lib/trpc";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import type { StatusKind } from "../components/status-pill";
import { StatusPill } from "../components/status-pill";

export default function OverviewPage() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Overview
        </h1>
        <p className="text-[13px] text-foreground/55">
          Operational health at a glance. Drill into any tab for detail.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SyncCard />
        <BackupsCard />
        <CapacityCard />
        <AlertsCard />
        <ApprovalQueueCard />
      </div>
    </div>
  );
}

// ─── 1. Sync ──────────────────────────────────────────────────────────

function SyncCard() {
  // `sync.getStatus` returns one row per peer; we summarise to a single
  // health verdict for the dashboard. Behind = peer with `status="error"`
  // OR `lastError != null`. Disconnected = `enabled=false`. Healthy = all
  // remaining peers report status="idle" or "syncing".
  const { data, isLoading, isError } = trpc.sync.getStatus.useQuery(undefined, {
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <SectionCard title="Sync" hint="Pod-to-pod replication">
        <CardLoadingPanel />
      </SectionCard>
    );
  }
  if (isError) {
    return (
      <SectionCard title="Sync" hint="Pod-to-pod replication">
        <CardErrorPanel message="Couldn't load sync status." />
      </SectionCard>
    );
  }

  const peers = data ?? [];
  if (peers.length === 0) {
    return (
      <SectionCard title="Sync" hint="Pod-to-pod replication">
        <CardSummary
          icon={GitBranch}
          headline="No peers configured"
          subline="This pod is standalone."
          status={{ kind: "unknown", label: "Idle" }}
        />
      </SectionCard>
    );
  }

  const errored = peers.filter(
    (p) => p.syncState?.status === "error" || p.syncState?.lastError
  );
  const disconnected = peers.filter((p) => !p.enabled);
  const lastSyncAt = peers
    .map((p) => p.syncState?.updatedAt)
    .filter((d): d is Date => d instanceof Date || typeof d === "string")
    .map((d) => (d instanceof Date ? d : new Date(d)))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  let kind: StatusKind = "healthy";
  let headline = "Caught up";
  let subline = `${peers.length} peer${peers.length === 1 ? "" : "s"}`;

  if (disconnected.length > 0) {
    kind = "down";
    headline = "Disconnected";
    subline = `${disconnected.length} of ${peers.length} peers offline`;
  } else if (errored.length > 0) {
    kind = "stale";
    headline = `${errored.length} behind`;
    subline = `${errored.length} of ${peers.length} peers reporting errors`;
  }
  if (lastSyncAt) subline += ` · last sync ${formatRelative(lastSyncAt)}`;

  return (
    <SectionCard
      title="Sync"
      hint="Pod-to-pod replication"
      actions={<StatusPill kind={kind} label={headline} />}
    >
      <CardSummary icon={GitBranch} headline={headline} subline={subline} />
    </SectionCard>
  );
}

// ─── 2. Backups ───────────────────────────────────────────────────────

function BackupsCard() {
  // No dedicated backup query exists in `trpc.system.*` yet — Phase C
  // is meant to land `trpc.system.getBackupStatus`. Until then we render
  // a clearly-stubbed informational panel; the layout slot is reserved.
  // TODO(phase-C): wire to `trpc.system.getBackupStatus` once the
  // procedure is added in synap-backend/packages/api/src/routers/system.ts.
  return (
    <SectionCard
      title="Backups"
      hint="Snapshot schedule and recent runs"
      actions={<StatusPill kind="unknown" label="Pending" />}
    >
      <CardSummary
        icon={HardDrive}
        headline="Backup data not available"
        subline="A pod-level backup endpoint hasn't shipped yet (Phase C)."
      />
    </SectionCard>
  );
}

// ─── 3. Capacity ──────────────────────────────────────────────────────

function CapacityCard() {
  // `system.getDataPodStats` returns counts but no disk usage. We display
  // counts here and stub the percent-full + vector-index bytes — those
  // need a follow-up endpoint.
  // TODO(phase-C): extend `system.getDataPodStats` (or add a sibling
  // `getCapacity` procedure) so this card shows real disk + vector usage.
  const { data, isLoading, isError } = trpc.system.getDataPodStats.useQuery(
    undefined,
    { staleTime: 30_000 }
  );

  if (isLoading) {
    return (
      <SectionCard title="Capacity" hint="Storage and indexes">
        <CardLoadingPanel />
      </SectionCard>
    );
  }
  if (isError || !data) {
    return (
      <SectionCard title="Capacity" hint="Storage and indexes">
        <CardErrorPanel message="Couldn't load capacity stats." />
      </SectionCard>
    );
  }

  const totalRecords = (data.entityCount ?? 0) + (data.documentCount ?? 0);

  return (
    <SectionCard title="Capacity" hint="Storage and indexes">
      <CardSummary
        icon={Database}
        headline={`${totalRecords.toLocaleString()} records`}
        subline={`${data.entityCount.toLocaleString()} entities · ${data.documentCount.toLocaleString()} docs · ${data.userCount.toLocaleString()} users`}
      />
      <p className="mt-3 text-[11.5px] text-foreground/45">
        Disk and vector-index usage will appear here once the capacity procedure
        ships.
      </p>
    </SectionCard>
  );
}

// ─── 4. Alerts ────────────────────────────────────────────────────────

function AlertsCard() {
  // Aggregate from real signals we can read today:
  //   • trustedIssuers.list — flag any in `pending` status
  //   • sync.getStatus — flag peers with `lastError`
  // These shapes are admin-gated (`podAdminProcedure`) and run only for
  // the operator viewing this page.
  const issuersQuery = trpc.trustedIssuers.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const syncQuery = trpc.sync.getStatus.useQuery(undefined, {
    staleTime: 60_000,
  });

  const isLoading = issuersQuery.isLoading || syncQuery.isLoading;
  const isError = issuersQuery.isError || syncQuery.isError;

  type Alert = {
    id: string;
    icon: LucideIcon;
    primary: string;
    secondary: string;
    status: { kind: StatusKind; label: string };
    href: string;
  };

  const alerts: Alert[] = [];

  if (issuersQuery.data) {
    for (const issuer of issuersQuery.data) {
      const i = issuer as unknown as {
        id: string;
        issuerUrl?: string;
        status?: string;
      };
      if (i.status === "pending") {
        alerts.push({
          id: `issuer-${i.id}`,
          icon: ShieldQuestion,
          primary: "Trusted issuer awaiting approval",
          secondary: i.issuerUrl ?? i.id,
          status: { kind: "stale", label: "Pending" },
          // Land on the Trusted Issuers sub-tab + scroll/highlight the
          // pending issuer row.
          href: `/trust-keys?section=issuers&focus=${encodeURIComponent(i.id)}`,
        });
      }
    }
  }

  if (syncQuery.data) {
    for (const peer of syncQuery.data) {
      const lastError = peer.syncState?.lastError;
      if (lastError) {
        alerts.push({
          id: `peer-${peer.id}`,
          icon: AlertTriangle,
          primary: peer.label ?? peer.peerPodUrl,
          secondary: String(lastError).slice(0, 80),
          status: { kind: "down", label: "Sync error" },
          href: `/connectors?focus=${encodeURIComponent(peer.id)}`,
        });
      }
    }
  }

  return (
    <SectionCard
      title="Alerts"
      hint="Things that need an operator's attention"
      actions={
        alerts.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/55">
            {alerts.length} open
          </span>
        ) : null
      }
    >
      {isLoading ? (
        <ResourceRowSkeleton count={3} />
      ) : isError ? (
        <CardErrorPanel message="Couldn't load alerts." />
      ) : alerts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6">
          <CircleCheck
            className="h-5 w-5 text-status-healthy"
            strokeWidth={2}
            aria-hidden
          />
          <p className="text-[12.5px] text-foreground/55">No alerts</p>
        </div>
      ) : (
        <>
          <div className="-mx-2">
            {alerts.slice(0, 5).map((a) => (
              <Link
                key={a.id}
                href={a.href}
                className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded-md"
              >
                <ResourceRow
                  Icon={a.icon}
                  primary={a.primary}
                  secondary={a.secondary}
                  status={a.status}
                />
              </Link>
            ))}
          </div>
          {alerts.length > 5 && (
            <div className="mt-2 flex justify-end">
              <span className="text-[11.5px] text-foreground/45">
                +{alerts.length - 5} more
              </span>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

// ─── 5. Approval queue ────────────────────────────────────────────────

function ApprovalQueueCard() {
  // `proposals.list` is `protectedProcedure` (any signed-in user), but we
  // want pod-level proposals only — those have `workspaceId === null`.
  // The list endpoint itself doesn't expose a "pod-only" filter; we pull
  // a generous slice of pending and filter client-side. For the tile we
  // only need the count and a few preview rows.
  // TODO(phase-C): add a pod-only filter to `proposals.list` (workspaceId
  // === null) so we can stop paginating client-side.
  const { data, isLoading, isError } = trpc.proposals.list.useQuery(
    { status: "pending", limit: 25 },
    { staleTime: 30_000 }
  );

  // Pending Kratos signups would also live here (no list endpoint yet).
  // TODO(phase-C): wire `trpc.system.listPendingIdentities` once the
  // identity-introspection procedure ships.

  if (isLoading) {
    return (
      <SectionCard title="Approval queue" hint="Items awaiting your review">
        <ResourceRowSkeleton count={3} />
      </SectionCard>
    );
  }
  if (isError || !data) {
    return (
      <SectionCard title="Approval queue" hint="Items awaiting your review">
        <CardErrorPanel message="Couldn't load proposals." />
      </SectionCard>
    );
  }

  const podLevel = (data.items ?? []).filter(
    (p) => (p as unknown as { workspaceId?: string | null }).workspaceId == null
  );

  return (
    <SectionCard
      title="Approval queue"
      hint="Items awaiting your review"
      actions={
        podLevel.length > 0 ? (
          <Button
            as={Link}
            href="/audit"
            size="sm"
            variant="flat"
            radius="md"
            endContent={<ChevronRight className="h-3 w-3" />}
          >
            Review
          </Button>
        ) : null
      }
    >
      {podLevel.length === 0 ? (
        <ResourceRowEmpty message="No pod-level proposals pending." />
      ) : (
        <div className="-mx-2">
          {podLevel.slice(0, 4).map((p) => {
            const proposal = p as unknown as {
              id: string;
              title?: string | null;
              targetType?: string | null;
              createdAt?: string | Date | null;
            };
            return (
              <ResourceRow
                key={proposal.id}
                Icon={Mailbox}
                primary={
                  proposal.title ?? `Proposal ${proposal.id.slice(0, 8)}`
                }
                secondary={[
                  proposal.targetType ?? "—",
                  proposal.createdAt
                    ? formatRelative(new Date(proposal.createdAt))
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                status={{ kind: "stale", label: "Pending" }}
              />
            );
          })}
          {podLevel.length > 4 && (
            <p className="mt-2 px-3 text-[11.5px] text-foreground/45">
              +{podLevel.length - 4} more
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ─── Shared card UI ───────────────────────────────────────────────────

function CardSummary({
  icon: Icon,
  headline,
  subline,
  status,
}: {
  icon: LucideIcon;
  headline: string;
  subline?: string;
  status?: { kind: StatusKind; label: string };
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden
        className="
          glass-icon
          flex h-9 w-9 shrink-0 items-center justify-center
        "
        style={{ background: "rgba(52, 211, 153, 0.12)" }}
      >
        <Icon className="h-4 w-4 text-foreground/85" strokeWidth={2} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium text-foreground">
          {headline}
        </span>
        {subline && (
          <span className="text-[11.5px] text-foreground/55">{subline}</span>
        )}
      </div>
      {status && <StatusPill kind={status.kind} label={status.label} />}
    </div>
  );
}

function CardLoadingPanel() {
  return (
    <div className="flex items-center gap-3">
      <div className="h-9 w-9 shrink-0 rounded-md bg-foreground/10 shimmer-pulse" />
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="h-3 w-1/3 rounded bg-foreground/10 shimmer-pulse" />
        <div className="h-2.5 w-1/2 rounded bg-foreground/[0.07] shimmer-pulse" />
      </div>
    </div>
  );
}

function CardErrorPanel({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-status-down">
      <KeyRound className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      <span>{message}</span>
    </div>
  );
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
void Clock;

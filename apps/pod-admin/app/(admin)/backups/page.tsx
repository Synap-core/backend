"use client";

/**
 * Backups — whether this pod's data is safe and in sync. The detail behind
 * the two rows Home's glance band summarises:
 *
 *   • Backups — `system.getBackupStatus` (the `backup_runs` ledger): status,
 *     the last good run, its size, and where it went.
 *   • Sync    — `sync.getStatus`: every peer pod, when it last synced, and
 *     each failure with the error the worker recorded. A failing peer offers
 *     one action, Retry (`sync.resetPeer` without touching its cursor): the
 *     workers stop retrying after `SYNC_GIVES_UP_AFTER` failures in a row and
 *     wait for exactly this reset.
 */

import { Button, addToast } from "@heroui/react";
import { GitBranch } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import {
  formatRelative,
  formatTimestamp,
  humanizeBytes,
} from "../../../lib/format";
import { PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import { StatusPill } from "../components/status-pill";
import {
  backupVerdict,
  directionWords,
  peerHasError,
  peerVerdict,
  syncSummary,
  type SyncPeerLike,
} from "./_lib/backup-model";

const relative = (d: Date | string) => formatRelative(d);

export default function BackupsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Backups"
        description="Whether this pod's data is backed up, and in sync with the other pods it pairs with."
      />
      <div className="flex flex-col gap-4">
        <BackupsCard />
        <SyncCard />
      </div>
    </PageShell>
  );
}

// ─── Backups ────────────────────────────────────────────────────────

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-[12px] text-foreground/65 sm:w-36">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-[12.5px] text-foreground">
        {value}
      </dd>
    </div>
  );
}

function BackupsCard() {
  const q = trpc.system.getBackupStatus.useQuery(undefined, {
    staleTime: 60_000,
  });
  useEffect(() => {
    if (q.isError) redirectToLoginIfUnauthorized(q.error);
  }, [q.isError, q.error]);

  return (
    <SectionCard title="Backups" hint="Copies of the pod's database">
      {q.isLoading ? (
        <ResourceRowSkeleton count={1} />
      ) : q.isError || !q.data ? (
        <ResourceRowError
          message="Couldn't read the backup ledger."
          onRetry={() => void q.refetch()}
        />
      ) : (
        <BackupFacts data={q.data} />
      )}
    </SectionCard>
  );
}

function BackupFacts({
  data,
}: {
  data: {
    status: "ok" | "stale" | "never" | "error";
    lastBackupAt: Date | string | null;
    sizeBytes: number | null;
    location: string | null;
  };
}) {
  const v = backupVerdict(data.status, data.lastBackupAt, relative);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <StatusPill kind={v.kind} label={v.label} />
        <p className="min-w-0 flex-1 text-[13px] text-foreground">
          {v.sentence}
        </p>
      </div>
      {data.status === "never" ? (
        <p className="text-[12.5px] text-foreground/65">
          Backups are run by the machine hosting the pod. Configure them with
          your hosting provider.
        </p>
      ) : (
        <dl className="flex flex-col gap-2">
          <Fact
            label="Last good backup"
            value={
              data.lastBackupAt
                ? `${formatTimestamp(data.lastBackupAt)} (${relative(data.lastBackupAt)})`
                : "None yet"
            }
          />
          {data.sizeBytes != null && (
            <Fact label="Size" value={humanizeBytes(data.sizeBytes)} />
          )}
          {data.location && <Fact label="Kept" value={data.location} />}
        </dl>
      )}
    </div>
  );
}

// ─── Sync ───────────────────────────────────────────────────────────

function SyncCard() {
  const q = trpc.sync.getStatus.useQuery(undefined, { staleTime: 60_000 });
  useEffect(() => {
    if (q.isError) redirectToLoginIfUnauthorized(q.error);
  }, [q.isError, q.error]);

  const peers: SyncPeerLike[] = q.data ?? [];
  const summary = q.data ? syncSummary(peers) : null;

  return (
    <SectionCard
      title="Sync"
      hint={summary?.sentence ?? "Other pods this pod replicates with"}
      actions={
        summary ? (
          <StatusPill kind={summary.kind} label={summary.label} />
        ) : null
      }
    >
      {q.isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : q.isError ? (
        <ResourceRowError
          message="Couldn't read the sync status."
          onRetry={() => void q.refetch()}
        />
      ) : peers.length === 0 ? (
        <ResourceRowEmpty message="This pod is standalone — it syncs with no other pod." />
      ) : (
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {peers.map((p) => (
            <PeerRow key={p.id} peer={p} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function PeerRow({ peer }: { peer: SyncPeerLike }) {
  const utils = trpc.useUtils();
  const reset = trpc.sync.resetPeer.useMutation({
    onSuccess: () => {
      void utils.sync.getStatus.invalidate();
      addToast({
        title: "Retrying",
        description: "The error was cleared; the next sync run tries again.",
        color: "default",
      });
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Couldn't reset this peer",
        description: err.message,
        color: "danger",
      });
    },
  });

  const v = peerVerdict(peer, relative);
  const host = hostOf(peer.peerPodUrl);
  const details = [
    peer.workspaceNames?.length
      ? `Only ${peer.workspaceNames.join(", ")}`
      : "Every space",
    peer.syncState?.eventsProcessed
      ? `${peer.syncState.eventsProcessed.toLocaleString()} events synced`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lastError = peer.syncState?.lastError;

  return (
    <div>
      <ResourceRow
        Icon={GitBranch}
        primary={peer.label || host}
        secondary={`${directionWords(peer.direction)} ${host} · ${v.sentence}`}
        status={{ kind: v.kind, label: v.label }}
        wrap
        actions={
          peer.enabled && peerHasError(peer) ? (
            <Button
              size="sm"
              variant="flat"
              radius="md"
              className="min-h-9"
              isLoading={reset.isPending}
              onPress={() => reset.mutate({ id: peer.id })}
            >
              Retry
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-1.5 px-3 pb-3 sm:pl-10">
        <p className="text-[11.5px] text-foreground/65">{details}</p>
        {lastError && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-status-down/[0.06] px-2.5 py-2 font-mono text-[11px] text-foreground/85 ring-1 ring-inset ring-status-down/20">
            {lastError}
          </pre>
        )}
      </div>
    </div>
  );
}

/** A peer URL as a person reads it: the host, or the raw string if unparseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

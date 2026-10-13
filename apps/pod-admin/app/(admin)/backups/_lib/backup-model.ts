/**
 * Sync and backup verdicts for the Backups page — pure, so every rule is
 * unit-tested and Home's glance band can read the same words.
 *
 * Inputs are the wire shapes of `sync.getStatus` (one row per peer, joined
 * with its `sync_state`) and `system.getBackupStatus`.
 */

import type { StatusKind } from "../../components/status-pill";

/**
 * Consecutive failures after which the sync workers stop retrying a peer
 * until someone resets it. MIRROR of `MAX_ERROR_COUNT` in
 * `packages/jobs/src/workers/sync-{push,pull,push-files}.ts` (all 10); only
 * the wording here depends on it.
 */
export const SYNC_GIVES_UP_AFTER = 10;

type WireDate = Date | string | null | undefined;

/** The slice of a `sync.getStatus` row this page reads. */
export interface SyncPeerLike {
  id: string;
  peerPodUrl: string;
  label?: string | null;
  direction: string;
  enabled: boolean;
  workspaceNames?: string[] | null;
  syncState?: {
    status: string;
    lastSyncAt?: WireDate;
    errorCount: number;
    lastError?: string | null;
    eventsProcessed?: number;
  } | null;
}

export interface Verdict {
  kind: StatusKind;
  label: string;
  /** One plain sentence. */
  sentence: string;
}

const DIRECTION_WORDS: Record<string, string> = {
  push: "Sends to",
  pull: "Receives from",
  bidirectional: "Syncs both ways with",
};

export function directionWords(direction: string): string {
  return DIRECTION_WORDS[direction] ?? "Syncs with";
}

export function peerHasError(peer: SyncPeerLike): boolean {
  return peer.syncState?.status === "error" || !!peer.syncState?.lastError;
}

/** Whether the workers have stopped retrying and wait for a reset. */
export function peerGaveUp(peer: SyncPeerLike): boolean {
  return (peer.syncState?.errorCount ?? 0) >= SYNC_GIVES_UP_AFTER;
}

export function peerVerdict(
  peer: SyncPeerLike,
  relative: (d: Date | string) => string
): Verdict {
  const state = peer.syncState;
  if (!peer.enabled) {
    return {
      kind: "down",
      label: "Off",
      sentence: "Switched off — nothing syncs with this peer.",
    };
  }
  if (peerHasError(peer)) {
    const n = state?.errorCount ?? 0;
    const tries = n === 1 ? "1 failed attempt" : `${n} failed attempts`;
    return {
      kind: peerGaveUp(peer) ? "down" : "stale",
      label: peerGaveUp(peer) ? "Stopped" : "Failing",
      sentence: peerGaveUp(peer)
        ? `Stopped retrying after ${tries}. Retry once the cause is fixed.`
        : n > 0
          ? `Failing — ${tries} in a row, still retrying.`
          : "The last attempt failed; it will retry.",
    };
  }
  if (state?.status === "syncing") {
    return { kind: "healthy", label: "Syncing", sentence: "Syncing now." };
  }
  if (!state?.lastSyncAt) {
    return {
      kind: "unknown",
      label: "Not yet",
      sentence: "Has not synced yet.",
    };
  }
  return {
    kind: "healthy",
    label: "Caught up",
    sentence: `Caught up — last synced ${relative(state.lastSyncAt)}.`,
  };
}

/** The page's one-line summary across every peer. */
export function syncSummary(peers: readonly SyncPeerLike[]): Verdict {
  if (peers.length === 0) {
    return {
      kind: "unknown",
      label: "Standalone",
      sentence: "This pod syncs with no other pod.",
    };
  }
  const off = peers.filter((p) => !p.enabled).length;
  const failing = peers.filter((p) => p.enabled && peerHasError(p)).length;
  const of = `of ${peers.length} peer${peers.length === 1 ? "" : "s"}`;
  if (failing > 0) {
    return {
      kind: "stale",
      label: `${failing} failing`,
      sentence: `${failing} ${of} ${failing === 1 ? "is" : "are"} failing to sync.`,
    };
  }
  if (off > 0) {
    return {
      kind: "down",
      label: `${off} off`,
      sentence: `${off} ${of} ${off === 1 ? "is" : "are"} switched off.`,
    };
  }
  return {
    kind: "healthy",
    label: "Caught up",
    sentence:
      peers.length === 1
        ? "The one peer is in sync."
        : `All ${peers.length} peers are in sync.`,
  };
}

export type BackupState = "ok" | "stale" | "never" | "error";

/** `system.getBackupStatus` — "ok" healthy, "stale" stale, "error" down. */
export function backupVerdict(
  status: BackupState,
  lastBackupAt: WireDate,
  relative: (d: Date | string) => string
): Verdict {
  const last = lastBackupAt ? relative(lastBackupAt) : null;
  switch (status) {
    case "ok":
      return {
        kind: "healthy",
        label: "Healthy",
        sentence: `Backed up ${last ?? "recently"}.`,
      };
    case "stale":
      return {
        kind: "stale",
        label: "Stale",
        // `BACKUP_STALE_AFTER_MS` (@synap/database) is 26 hours.
        sentence: last
          ? `No backup has succeeded in over a day. The last good one is from ${last}.`
          : "No backup has ever succeeded.",
      };
    case "error":
      // Collapses `failed` (the newest run or restore drill failed) and
      // `suspect` (the newest run saw a data drop and was kept aside).
      return {
        kind: "down",
        label: "Failing",
        sentence: last
          ? `The latest backup or restore check failed, or saw data missing. The last good backup is from ${last}.`
          : "The latest backup or restore check failed, and there is no good backup yet.",
      };
    case "never":
      return {
        kind: "unknown",
        label: "Never",
        sentence: "This pod has never recorded a backup.",
      };
  }
}

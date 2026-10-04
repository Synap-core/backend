/**
 * Backup status — the ONE derivation of "where do this pod's backups stand",
 * read from the `backup_runs` ledger (migration 0295) that
 * deploy/pgdata-safety.sh writes after every backup and restore drill.
 *
 * Consumers: GET /status/backup (apps/api, public metadata) and
 * system.getBackupStatus (pod-admin). Neither re-derives the rule.
 *
 * The status, worst first:
 *   suspect — the newest backup run saw a data drop (0 users / entities
 *             halved): it was kept aside and NOT pushed. Most urgent: the live
 *             pod may have lost its data.
 *   failed  — the newest backup run failed, or the newest restore drill went
 *             red (a backup that does not restore is not a backup).
 *   stale   — no successful backup within STALE_AFTER_MS.
 *   never   — no backup run was ever recorded.
 *   ok      — otherwise. `offsite` says whether that success reached the
 *             off-host repository (false = local dump only).
 *
 * A failed READ of the ledger is not "never": `readBackupStatus` throws, and
 * the caller reports the error.
 */

import { sql as defaultSql } from "../client-pg.js";

export const BACKUP_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

export type BackupHealth = "ok" | "stale" | "failed" | "suspect" | "never";

/** One `backup_runs` row as the database returns it (snake_case). */
export interface BackupRunDbRow {
  kind: string;
  status: string;
  started_at: Date | string;
  finished_at: Date | string;
  size_bytes: number | string | null;
  snapshot_id: string | null;
  fingerprint: string | null;
  drill_fingerprint: string | null;
  detail: string | null;
}

export interface BackupRunSummary {
  at: string;
  status: "ok" | "failed" | "suspect";
  sizeBytes: number | null;
  snapshotId: string | null;
  /** users|entities|api_keys counts. Withheld from the public route. */
  fingerprint: string | null;
  /** Restored fingerprint (drills only). */
  drillFingerprint: string | null;
  /** Short reason for a failed / suspect run. Withheld from the public route. */
  detail: string | null;
}

export interface BackupStatus {
  status: BackupHealth;
  /** The newest successful backup reached the off-host repository. */
  offsite: boolean;
  lastBackup: BackupRunSummary | null;
  lastSuccess: BackupRunSummary | null;
  lastDrill: BackupRunSummary | null;
  staleAfterHours: number;
}

function iso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function summarize(row: BackupRunDbRow | undefined): BackupRunSummary | null {
  if (!row) return null;
  const size = row.size_bytes == null ? null : Number(row.size_bytes);
  return {
    at: iso(row.finished_at),
    status: row.status as BackupRunSummary["status"],
    sizeBytes: Number.isFinite(size) ? size : null,
    snapshotId: row.snapshot_id,
    fingerprint: row.fingerprint,
    drillFingerprint: row.drill_fingerprint,
    detail: row.detail,
  };
}

/** Pure projection. `rows` may come in any order. */
export function projectBackupStatus(
  rows: ReadonlyArray<BackupRunDbRow>,
  now: Date = new Date()
): BackupStatus {
  const newestFirst = [...rows].sort(
    (a, b) => +new Date(b.finished_at) - +new Date(a.finished_at)
  );
  const backups = newestFirst.filter((r) => r.kind === "backup");
  const lastBackup = summarize(backups[0]);
  const lastSuccess = summarize(backups.find((r) => r.status === "ok"));
  const lastDrill = summarize(newestFirst.find((r) => r.kind === "drill"));

  let status: BackupHealth;
  if (!lastBackup) status = "never";
  else if (lastBackup.status === "suspect") status = "suspect";
  else if (lastBackup.status === "failed" || lastDrill?.status === "failed")
    status = "failed";
  else if (
    !lastSuccess ||
    now.getTime() - new Date(lastSuccess.at).getTime() > BACKUP_STALE_AFTER_MS
  )
    status = "stale";
  else status = "ok";

  return {
    status,
    offsite: Boolean(lastSuccess?.snapshotId),
    lastBackup,
    lastSuccess,
    lastDrill,
    staleAfterHours: BACKUP_STALE_AFTER_MS / 3_600_000,
  };
}

/** The columns read — also the only ones a consumer can ever see. */
export const BACKUP_RUNS_SELECT = `
  SELECT kind, status, started_at, finished_at, size_bytes, snapshot_id,
         fingerprint, drill_fingerprint, detail
    FROM backup_runs
   ORDER BY finished_at DESC
   LIMIT 200`;

/**
 * Read the ledger and project it. THROWS when the read fails (table missing,
 * database down) — never folds a failed read into "never".
 */
export async function readBackupStatus(
  query: (text: string) => Promise<ReadonlyArray<BackupRunDbRow>> = (text) =>
    defaultSql.unsafe(text) as unknown as Promise<BackupRunDbRow[]>,
  now: Date = new Date()
): Promise<BackupStatus> {
  return projectBackupStatus(await query(BACKUP_RUNS_SELECT), now);
}

/**
 * The `migrations` block of GET /status/release, from the `_migrations` rows.
 *
 * `lastApplied` is the NEWEST migration by name — the one deploy verification
 * compares with the newest file it ships (deploy/verify-deploy.sh) — never
 * the one applied most recently. A migration authored on a branch can land
 * with a number below migrations a pod already has; the runner applies it
 * (every missing file, in name order) and it is then the latest by time.
 * Reporting it as `lastApplied` made a good update look like a migrate run
 * that fell behind, and the engine rolled pod.antoinesrvt back for it
 * (2026-10-20: 0331 merged after 0336 was applied).
 * `lastAppliedAt` stays the time of the most recent migration run.
 */
export interface MigrationLedgerRow {
  filename: string;
  applied_at: string | Date;
}

export interface MigrationLedger {
  lastApplied: string | null;
  lastAppliedAt: string | null;
  count: number;
}

export function summarizeMigrationLedger(
  rows: readonly MigrationLedgerRow[]
): MigrationLedger {
  let newest: string | null = null;
  let latestAt: number | null = null;
  for (const row of rows) {
    if (newest === null || row.filename > newest) newest = row.filename;
    const at = new Date(row.applied_at).getTime();
    if (!Number.isNaN(at) && (latestAt === null || at > latestAt)) latestAt = at;
  }
  return {
    lastApplied: newest,
    lastAppliedAt: latestAt === null ? null : new Date(latestAt).toISOString(),
    count: rows.length,
  };
}

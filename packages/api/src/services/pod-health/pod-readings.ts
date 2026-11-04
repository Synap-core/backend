/**
 * The pod's own numbers, read by the backend itself beside the host's file:
 * Postgres connections against `max_connections`, the database size, the
 * last backup (`readBackupStatus`, the same rule `/status/backup` reads) and
 * the event-loop delay `/health` reports (backend#734).
 *
 * Each read is independent and reports `null` = unavailable when it fails:
 * one failed probe never hides the others, and never reads as 0.
 */

import { createLogger } from "@synap-core/core";
import { db, drizzleSql, readBackupStatus } from "@synap/database";
import type { PodOwnReadings } from "./evaluate.js";

const logger = createLogger({ module: "pod-health-readings" });

/**
 * The event-loop reader lives in apps/api (`status/event-loop-watch.ts`),
 * which this package cannot import. apps/api fills this slot at boot with a
 * reader of the same snapshot `/health` serves; unfilled = unavailable.
 */
type EventLoopP99Reader = () => number | null;
let eventLoopP99Reader: EventLoopP99Reader | null = null;

export function registerEventLoopP99Reader(fn: EventLoopP99Reader): void {
  eventLoopP99Reader = fn;
}

async function postgresConnections(): Promise<{
  used: number;
  max: number;
} | null> {
  try {
    const rows = (await db.execute(drizzleSql`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity) AS used,
        current_setting('max_connections')::int AS max
    `)) as unknown as Array<{ used: number | string; max: number | string }>;
    const used = Number(rows[0]?.used);
    const max = Number(rows[0]?.max);
    return Number.isFinite(used) && Number.isFinite(max) && max > 0
      ? { used, max }
      : null;
  } catch (err) {
    logger.warn({ err }, "Could not read Postgres connections");
    return null;
  }
}

async function databaseSizeBytes(): Promise<number | null> {
  try {
    const rows = (await db.execute(drizzleSql`
      SELECT pg_database_size(current_database())::bigint AS bytes
    `)) as unknown as Array<{ bytes: number | string }>;
    const bytes = Number(rows[0]?.bytes);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  } catch (err) {
    logger.warn({ err }, "Could not read the database size");
    return null;
  }
}

async function backup(): Promise<PodOwnReadings["backup"]> {
  try {
    const s = await readBackupStatus();
    return { status: s.status, lastSuccessAt: s.lastSuccess?.at ?? null };
  } catch (err) {
    logger.warn({ err }, "Could not read the backup status");
    return null;
  }
}

function eventLoopP99Ms(): number | null {
  try {
    const v = eventLoopP99Reader?.() ?? null;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

export async function readPodOwnReadings(): Promise<PodOwnReadings> {
  const [pg, size, bk] = await Promise.all([
    postgresConnections(),
    databaseSizeBytes(),
    backup(),
  ]);
  return {
    postgresConnections: pg,
    databaseSizeBytes: size,
    eventLoopP99Ms: eventLoopP99Ms(),
    backup: bk,
  };
}

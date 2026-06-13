/**
 * Temporal retrieval signal (Phase 3).
 *
 * When the query implies recency (understanding.temporal — "what changed", "the
 * latest", "recent"), recently-active entities should rise. We ground "activity"
 * in the EVENT CHAIN (the real last-touch per entity), falling back to
 * `updatedAt`. The boost is a BOUNDED decay (half-life 7d) folded into the
 * composite re-rank — a nudge, never a partition (same contract as property hints).
 *
 * `recencyScore` is pure (testable); `latestEventTimestamps` is the one DB read.
 * See team/platform/retrieval-architecture.mdx, Phase 3.
 */
import { db, events } from "@synap/database";
import { sql as rawSql } from "drizzle-orm";

/**
 * MAX(event.timestamp) per entity id — the real "last activity" from the append-
 * only chain, which is more meaningful than `updatedAt` (a write can touch a row
 * without it being the latest *activity*). Only queried when the query is temporal.
 */
export async function latestEventTimestamps(
  entityIds: string[],
  userId: string
): Promise<Map<string, Date>> {
  if (entityIds.length === 0) return new Map();
  const rows = await db
    .select({
      subjectId: events.subjectId,
      lastSeen: rawSql<Date>`MAX(${events.timestamp})`.as("last_seen"),
    })
    .from(events)
    // user-scoped — every other read in the engine is; an unscoped read on the
    // shared events table is the exact anti-pattern the read-scoping tripwire flags.
    .where(
      rawSql`${events.subjectType} = 'entity' AND ${events.userId} = ${userId} AND ${events.subjectId} = ANY(${entityIds})`
    )
    .groupBy(events.subjectId);
  return new Map(
    rows
      .filter((r): r is { subjectId: string; lastSeen: Date } => !!r.subjectId)
      .map((r) => [r.subjectId, r.lastSeen])
  );
}

export interface TemporalRow {
  updatedAt: Date | string | null;
}

const HALF_LIFE_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * Recency score in [0,1]: 2^(-ageDays / halfLife). Prefers the event-chain
 * timestamp when available, else `updatedAt`. Future-dated → 1 (maximally
 * relevant for "upcoming"). Unparseable/absent → 0 (no boost).
 */
export function recencyScore(
  row: TemporalRow,
  now: number,
  eventTs?: Date
): number {
  const raw = eventTs ?? row.updatedAt;
  const ts = raw instanceof Date ? raw : raw ? new Date(raw) : null;
  if (!ts || Number.isNaN(ts.getTime())) return 0;
  const ageDays = (now - ts.getTime()) / DAY_MS;
  if (ageDays <= 0) return 1;
  return Math.pow(2, -ageDays / HALF_LIFE_DAYS);
}

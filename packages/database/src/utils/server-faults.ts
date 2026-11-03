/**
 * SERVER FAULTS (0392) — write one 5xx's exact cause, expire it after 30 days,
 * read it back for a pod admin.
 *
 * The writer is `recordServerFault` (@synap/api `services/server-faults/`),
 * which describes and redacts the error first; these are the plain row doors.
 */

import { desc, eq, lt } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  serverFaults,
  type NewServerFault,
  type ServerFault,
} from "../schema/server-faults.js";

/** Any drizzle Postgres handle (the pod's `db`, a transaction, PGlite in tests). */
export type ServerFaultDb = PgDatabase<PgQueryResultHKT, any, any>;

export const SERVER_FAULT_RETENTION_DAYS = 30;

/** Write one fault. A second write of the same errorId is ignored. */
export async function insertServerFault(
  executor: ServerFaultDb,
  row: NewServerFault
): Promise<void> {
  await executor
    .insert(serverFaults)
    .values(row)
    .onConflictDoNothing({ target: serverFaults.errorId });
}

/** Delete faults older than `days` (default 30). Returns how many rows went. */
export async function deleteExpiredServerFaults(
  executor: ServerFaultDb,
  days: number = SERVER_FAULT_RETENTION_DAYS,
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const gone = await executor
    .delete(serverFaults)
    .where(lt(serverFaults.occurredAt, cutoff))
    .returning({ errorId: serverFaults.errorId });
  return gone.length;
}

/** One fault by its errorId, or null when none is stored (expired, or never written). */
export async function readServerFault(
  executor: ServerFaultDb,
  errorId: string
): Promise<ServerFault | null> {
  const rows = await executor
    .select()
    .from(serverFaults)
    .where(eq(serverFaults.errorId, errorId))
    .limit(1);
  return rows[0] ?? null;
}

/** The most recent faults, newest first (default 50, max 200). */
export async function listServerFaults(
  executor: ServerFaultDb,
  opts: { limit?: number; before?: Date } = {}
): Promise<ServerFault[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const base = executor.select().from(serverFaults);
  const filtered = opts.before
    ? base.where(lt(serverFaults.occurredAt, opts.before))
    : base;
  return filtered.orderBy(desc(serverFaults.occurredAt)).limit(limit);
}

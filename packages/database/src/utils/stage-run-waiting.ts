/**
 * SQL: a step of the session whose id is `sessionId` WAITS — on a child run
 * (`waiting_child`, a step that IS a playbook), on tools being installed
 * (`waiting_tools`) or on the approval to start its agent's task
 * (`waiting_start`) — through its open `session_stage_runs` row (0417).
 *
 * A run or session in that state is waiting, not idle: the playbook-run
 * reaper and the session stale flip skip it (runner engine spec 7111934d,
 * risk 3). One rule, read by both reapers.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const WAITING_STAGE_RUN_STATUSES = [
  "waiting_child",
  "waiting_tools",
  // Starting its agent's provider task waits for the person's approval.
  "waiting_start",
] as const;

const WAITING_SQL_LIST = drizzleSql.raw(
  WAITING_STAGE_RUN_STATUSES.map((s) => `'${s}'`).join(", ")
);

export function stageRunWaitsWhere(sessionId: AnyPgColumn | SQL): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM session_stage_runs ssr
    WHERE ssr.session_id = ${sessionId}
      AND ssr.status IN (${WAITING_SQL_LIST})
  )`;
}

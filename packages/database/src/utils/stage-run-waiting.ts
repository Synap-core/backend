/**
 * SQL: a step of the session whose id is `sessionId` WAITS — on a child run
 * (`waiting_child`, a step that IS a playbook), on tools being installed
 * (`waiting_tools`) or on the approval to start its agent's task
 * (`waiting_start`) — through its open `session_stage_runs` row (0422).
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

/**
 * A pulling agent counts as LIVE when it called the pod within this window:
 * THE liveness rule of the hand-off roster (`live` in `agents-for-handoff.ts`)
 * and the session holder. `synap worker` polls every 30s and key use is
 * stamped at most once a minute (`api_keys.last_used_at`); its back-off on
 * failed reads caps at 10 minutes. Lives here so the reapers (which cannot
 * import @synap/api) read the same number; `agent-presence.ts` re-exports it.
 */
export const PULL_LIVE_WINDOW_MS = 15 * 60_000;

/**
 * SQL: the session whose id is `sessionId` has a step HANDED to an agent on a
 * computer (open `session_stage_runs` row, `running`, with `runner_agent_user_id`
 * and `computer_user_id`) AND that agent is LIVE: one of its hub keys was used
 * within {@link PULL_LIVE_WINDOW_MS} (`api_keys.last_used_at`, the signal
 * `loadAgentPresence` reads as `lastSeenAt`). While true the agent is working
 * the step, so the playbook-run reaper does not count the run as quiet. Once
 * the agent goes silent (no key use for that window) this is false and the
 * run's own window applies.
 */
export function stageRunAgentLiveWhere(sessionId: AnyPgColumn | SQL): SQL {
  const windowSeconds = Math.round(PULL_LIVE_WINDOW_MS / 1000);
  return drizzleSql`EXISTS (
    SELECT 1 FROM session_stage_runs ssr
    WHERE ssr.session_id = ${sessionId}
      AND ssr.status = 'running'
      AND ssr.ended_at IS NULL
      AND ssr.runner_agent_user_id IS NOT NULL
      AND ssr.computer_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM api_keys ak
        WHERE ak.user_id = ssr.runner_agent_user_id
          AND ak.key_type = 'hub_inbound'
          AND ak.last_used_at > now() - (${windowSeconds}::int * interval '1 second')
      )
  )`;
}

/**
 * Connection Sync Run Worker
 *
 * Executes the ONE connection sync door (`runConnectionSync` in @synap/api) for
 * a job enqueued by a trigger (connect / CP webhook poke / manual), and runs the
 * steady tick when the scheduled job carries no provider.
 *
 * Runs IN the backend (apps/api) process; @synap/jobs cannot statically import
 * @synap/api (circular dep), so apps/api fills the runner slot at boot via
 * `registerConnectionSyncRunner()` — the IoC pattern used across this package.
 *
 * Unlike the fire-and-log cron slots, an UNREGISTERED runner throws: a queued
 * user-triggered sync must fail visibly (and retry), never be acked as done.
 * Per-kind failures are recorded by the runner itself on the connection's sync
 * state; only an infrastructure failure reaches pg-boss.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "connection-sync-run" });

export const CONNECTION_SYNC_RUN_QUEUE = "connection-sync-run";

/** Steady tick: every 30 min, every sync-enabled connection. */
export const CONNECTION_SYNC_CRON = "*/30 * * * *";

export interface ConnectionSyncJobData {
  /** Absent on the scheduled tick = every registered provider. */
  provider?: string;
  connectionId?: string;
  workspaceId?: string | null;
  reason?: "connect" | "cron" | "webhook" | "manual";
}

type ConnectionSyncRunner = (data: ConnectionSyncJobData) => Promise<unknown>;

let connectionSyncRunner: ConnectionSyncRunner | null = null;

export function registerConnectionSyncRunner(fn: ConnectionSyncRunner): void {
  connectionSyncRunner = fn;
}

export async function handleConnectionSyncRun(
  job: PgBoss.Job<ConnectionSyncJobData>
): Promise<void> {
  if (!connectionSyncRunner) {
    throw new Error("connection-sync runner not registered");
  }
  const data = job.data ?? {};
  const result = await connectionSyncRunner(data);
  logger.info(
    { result, reason: data.reason, provider: data.provider },
    "connection-sync run complete"
  );
}

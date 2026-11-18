/**
 * Compute lease sweeper (cron: every 5 min) — plan a640c5bb B3.
 *
 * Thin scheduler: on a tick it invokes the api-side sweeper
 * (`releaseExpiredComputeLeases`, services/compute), which runs each active
 * compute lease's release verb in mode `destroy` once its time to live is up
 * (pre-approved by the start, founder 18 Nov 2026).
 *
 * Runs IN the backend (apps/api) process; @synap/jobs cannot import @synap/api
 * (circular dep), so apps/api fills this slot at boot via
 * `registerComputeLeaseSweeper()` — the same IoC pattern as
 * `external-agent-poll`. Unregistered, a tick is logged LOUD and skipped: a
 * machine past its TTL keeps costing until a registered tick releases it.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "compute-lease-sweeper" });

export const COMPUTE_LEASE_SWEEPER_QUEUE = "compute-lease-sweeper";
export const COMPUTE_LEASE_SWEEPER_CRON = "*/5 * * * *";

type ComputeLeaseSweeper = () => Promise<unknown>;

let sweeper: ComputeLeaseSweeper | null = null;

export function registerComputeLeaseSweeper(fn: ComputeLeaseSweeper): void {
  sweeper = fn;
}

export async function handleComputeLeaseSweep(
  _job?: PgBoss.Job
): Promise<void> {
  if (!sweeper) {
    logger.error(
      "compute lease sweeper not registered — machines past their TTL are not released this tick"
    );
    return;
  }
  try {
    const result = await sweeper();
    logger.info({ result }, "compute lease sweep complete");
  } catch (err) {
    logger.error({ err }, "compute lease sweep failed");
  }
}

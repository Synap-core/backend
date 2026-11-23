/**
 * Degraded-capture sweep (cron): text captures saved raw because the AI was
 * unavailable or over quota are structured once it answers again.
 *
 * Thin scheduler: the sweep itself (`sweepDegradedCaptures`,
 * `services/captures/restructure-degraded-captures.ts`) lives in @synap/api,
 * which @synap/jobs cannot import (circular dep), so apps/api fills the runner
 * slot at boot — the same IoC pattern as cal-backfill / fireflies. A tick
 * SWALLOWS a failure: a cron must not retry-storm, and the next tick sweeps
 * again.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "degraded-capture-sweep" });

export const DEGRADED_CAPTURE_SWEEP_QUEUE = "degraded-capture-sweep";
export const DEGRADED_CAPTURE_SWEEP_CRON = "*/30 * * * *";

type DegradedCaptureSweepRunner = () => Promise<unknown>;

let degradedCaptureSweepRunner: DegradedCaptureSweepRunner | null = null;

export function registerDegradedCaptureSweepRunner(
  fn: DegradedCaptureSweepRunner
): void {
  degradedCaptureSweepRunner = fn;
}

export async function handleDegradedCaptureSweep(
  _job: PgBoss.Job
): Promise<void> {
  if (!degradedCaptureSweepRunner) {
    logger.warn("degraded-capture sweep runner not registered — skipping tick");
    return;
  }
  try {
    const result = await degradedCaptureSweepRunner();
    logger.info({ result }, "degraded-capture sweep complete");
  } catch (err) {
    logger.error({ err }, "degraded-capture sweep failed");
  }
}

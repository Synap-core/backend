/**
 * The pod health check — every 2 minutes, the host's resource readings and
 * the pod's own numbers are evaluated against the alert thresholds
 * (`api/src/services/pod-health/`, plan P3, G10).
 *
 * A handler SLOT filled by the api layer at boot (the one-way `api → jobs`
 * dependency): the check writes through `NotificationService` and reads the
 * pod settings, both in api — the same IoC as `morning-brief-worker.ts`.
 * jobs owns only the queue and its cron (one run per tick across processes).
 */

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "pod-health-worker" });

export const POD_HEALTH_QUEUE = "pod-health-check";
/** The host samples every 2 min (heal tick); the check follows it. */
export const POD_HEALTH_CRON = "*/2 * * * *";

export interface PodHealthJobResult {
  level: "ok" | "warning" | "critical";
  sent: number;
  cleared: number;
  failed: number;
}

type PodHealthHandler = () => Promise<PodHealthJobResult>;

let podHealthHandler: PodHealthHandler | null = null;

export function registerPodHealthHandler(fn: PodHealthHandler): void {
  podHealthHandler = fn;
}

export async function handlePodHealth(): Promise<PodHealthJobResult | null> {
  if (!podHealthHandler) {
    // Boot order: the cron can fire before the api filled the slot. Nothing
    // is lost: the next tick evaluates the next sample.
    logger.warn("pod-health handler not registered yet — skipped");
    return null;
  }
  return podHealthHandler();
}

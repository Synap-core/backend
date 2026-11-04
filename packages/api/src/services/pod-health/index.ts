/**
 * Pod health — resource alerts (plan P3, G10, decision 8d8c2fef).
 *
 *   host file (`state/resources.json`) + the pod's own numbers
 *     → `evaluateResources` (pure, one derivation)
 *     → the cron persists its state and notifies (`runPodHealthCheck`)
 *     → the Pod health page, diagnose's `resources` section and the
 *       provision status read the same evaluation as a dry run
 *       (`readPodHealth`).
 *
 * Durable state: `pod_settings.settings.resourceAlertState` (who was told,
 * streaks, since when), thresholds: `pod_settings.settings.resourceAlerts`.
 */

import { createLogger } from "@synap-core/core";
import {
  readPodSettingsKey,
  writePodSettingsKey,
} from "../media-copy/backfill-media-copy.js";
import {
  evaluateResources,
  parseAlertState,
  planNotifications,
  RESOURCE_ALERT_STATE_SETTING,
  type AlertLevel,
  type Evaluation,
  type PodOwnReadings,
  type ResourceAlertState,
} from "./evaluate.js";
import { readHostResources, type HostReadingsRead } from "./host-readings.js";
import { readPodOwnReadings } from "./pod-readings.js";
import {
  sendResourceNotifications,
  type ResourceNotifyDeps,
} from "./notify.js";
import {
  RESOURCE_ALERTS_SETTING,
  resolveResourceAlertThresholds,
  type ResourceAlertThresholds,
  type ThresholdMetric,
} from "./thresholds.js";

export * from "./evaluate.js";
export * from "./host-readings.js";
export * from "./thresholds.js";
export * from "./clean-request.js";
export {
  POD_RESOURCE_WARNING_TYPE,
  describeResourceAlert,
  resourceWarningGroupKey,
  sendResourceNotifications,
} from "./notify.js";
export {
  registerEventLoopP99Reader,
  readPodOwnReadings,
} from "./pod-readings.js";

const logger = createLogger({ module: "pod-health" });

export interface PodHealthDeps {
  now(): Date;
  readThresholdsRaw(): Promise<unknown>;
  readStateRaw(): Promise<unknown>;
  writeState(state: ResourceAlertState): Promise<void>;
  readHost(): Promise<HostReadingsRead>;
  readPod(): Promise<PodOwnReadings>;
  notify?: ResourceNotifyDeps;
}

export const defaultPodHealthDeps: PodHealthDeps = {
  now: () => new Date(),
  readThresholdsRaw: () => readPodSettingsKey(RESOURCE_ALERTS_SETTING),
  readStateRaw: () => readPodSettingsKey(RESOURCE_ALERT_STATE_SETTING),
  writeState: (state) =>
    writePodSettingsKey(RESOURCE_ALERT_STATE_SETTING, state),
  readHost: () => readHostResources(),
  readPod: () => readPodOwnReadings(),
};

export interface PodHealthRead {
  evaluation: Evaluation;
  thresholds: ResourceAlertThresholds & { explicit: ThresholdMetric[] };
}

/** A dry run: the evaluation the next tick would make, nothing written. */
export async function readPodHealth(
  deps: PodHealthDeps = defaultPodHealthDeps
): Promise<PodHealthRead> {
  const [thresholdsRaw, stateRaw, host, pod] = await Promise.all([
    deps.readThresholdsRaw(),
    deps.readStateRaw(),
    deps.readHost(),
    deps.readPod(),
  ]);
  const thresholds = resolveResourceAlertThresholds(thresholdsRaw);
  const evaluation = evaluateResources({
    now: deps.now(),
    host,
    pod,
    thresholds,
    previous: parseAlertState(stateRaw),
  });
  return { evaluation, thresholds };
}

export interface PodHealthTickResult {
  level: AlertLevel;
  sent: number;
  cleared: number;
  failed: number;
}

/**
 * The tick (cron, every 2 min): evaluate, notify, persist. A failed settings
 * read throws (the tick is skipped and pg-boss logs it): evaluating against
 * a state we could not read would re-notify every open alert.
 */
export async function runPodHealthCheck(
  deps: PodHealthDeps = defaultPodHealthDeps
): Promise<PodHealthTickResult> {
  const { evaluation } = await readPodHealth(deps);
  const plan = planNotifications(evaluation.state);
  const result = await sendResourceNotifications(plan, deps.notify);
  await deps.writeState(plan.state);
  if (plan.raise.length > 0 || plan.clear.length > 0) {
    logger.info(
      {
        raised: plan.raise.map((r) => `${r.metric}:${r.level}`),
        clearedMetrics: plan.clear,
        ...result,
      },
      "Pod resource alerts changed"
    );
  }
  return { level: evaluation.level, ...result };
}

/** The alerts open right now, for a status report (metadata only). */
export function openResourceAlerts(evaluation: Evaluation): Array<{
  metric: string;
  level: Exclude<AlertLevel, "ok">;
  since: string | null;
  value: number | null;
}> {
  return Object.entries(evaluation.state.metrics)
    .filter(([, m]) => m.level !== "ok")
    .map(([metric, m]) => ({
      metric,
      level: m.level as Exclude<AlertLevel, "ok">,
      since: m.since,
      value: m.value,
    }))
    .sort((a, b) =>
      a.level === b.level
        ? a.metric.localeCompare(b.metric)
        : a.level === "critical"
          ? -1
          : 1
    );
}

/**
 * The `resources` part of `GET /api/provision/status` (what the Control
 * Plane's health poll reads): the level, whether the host still reports, and
 * the open alerts. Metadata only — no path, no host name. A failed read says
 * so; it never reads as "ok".
 */
export type PodResourcesStatus =
  | {
      read: "ok";
      level: AlertLevel;
      hostState: Evaluation["hostState"];
      hostSampledAt: string | null;
      alerts: ReturnType<typeof openResourceAlerts>;
    }
  | { read: "failed" };

export async function podResourcesStatus(
  deps: PodHealthDeps = defaultPodHealthDeps
): Promise<PodResourcesStatus> {
  try {
    const { evaluation } = await readPodHealth(deps);
    return {
      read: "ok",
      level: evaluation.level,
      hostState: evaluation.hostState,
      hostSampledAt: evaluation.hostSampledAt,
      alerts: openResourceAlerts(evaluation),
    };
  } catch (err) {
    logger.warn({ err }, "Could not read the pod's resources for the status");
    return { read: "failed" };
  }
}

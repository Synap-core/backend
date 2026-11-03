/**
 * Resource alerts → the bell, through the ONE notification door
 * (`NotificationService.create`), to the pod owner + admins
 * (`resolvePodAdminUserIds`, the audience of the update outcome notice).
 *
 * Type `pod.resource_warning` (the registry's old, never-sent
 * `pod.storage_warning`, generalised). Pod-wide (`workspaceId: null`),
 * `sourceType: "system"`, one group per metric (`groupBy: "metric"`, so the
 * row's groupKey is `pod:pod.resource_warning:<metric>`).
 *
 * Once per metric and level: `planNotifications` (pure, `evaluate.ts`) says
 * what to raise, and the durable state's `notified` field is what keeps a
 * restart or the next tick from sending it again. Cleared when resolved: the
 * open rows of that metric's group are dismissed.
 *
 * The words are English, as the registry renders today (i18n.md §8: per-
 * reader rendering is not built). One sentence per metric and level, never
 * assembled from parts.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  notifications,
  NotificationStatus,
} from "@synap/database";
import { NotificationService } from "../../notifications/NotificationService.js";
import { resolvePodAdminUserIds } from "../capabilities/pod-owner.js";
import type { AlertLevel, NotificationPlan } from "./evaluate.js";

const logger = createLogger({ module: "pod-health-notify" });

/** Spelled as `type:` so the producer tripwire sees this file produce it. */
const resourceWarning = { type: "pod.resource_warning" } as const;
export const POD_RESOURCE_WARNING_TYPE = resourceWarning.type;

export function resourceWarningGroupKey(metric: string): string {
  return `pod:${POD_RESOURCE_WARNING_TYPE}:${metric}`;
}

type Level = Exclude<AlertLevel, "ok">;

const HEADLINES: Record<string, Record<Level, string>> = {
  memory: {
    warning: "Your pod’s memory is running high",
    critical: "Your pod is nearly out of memory",
  },
  swap: {
    warning: "Your pod’s host is swapping",
    critical: "Your pod’s host is swapping heavily",
  },
  memoryPressure: {
    warning: "Your pod is waiting on memory",
    critical: "Your pod is stalling for lack of memory",
  },
  disk: {
    warning: "Your pod’s disk is filling up",
    critical: "Your pod’s disk is nearly full",
  },
  postgresConnections: {
    warning: "Your pod’s database is running out of connections",
    critical: "Your pod’s database is nearly out of connections",
  },
  readings: {
    warning: "Your pod’s host stopped reporting its readings",
    critical: "Your pod’s host stopped reporting its readings",
  },
};

const DETAIL =
  "Open Pod health in pod admin to see the readings and what frees room.";

/** The headline for one alert. Pure. */
export function describeResourceAlert(metric: string, level: Level): string {
  const family = metric.startsWith("disk:") ? "disk" : metric;
  return (
    HEADLINES[family]?.[level] ??
    (level === "critical"
      ? "A resource on your pod is critical"
      : "A resource on your pod is running high")
  );
}

export interface ResourceNotifyDeps {
  recipients(): Promise<string[]>;
  create(
    input: Parameters<typeof NotificationService.create>[0]
  ): Promise<string | undefined>;
  /** Dismiss the open rows of one metric's group. */
  dismiss(metric: string): Promise<void>;
}

export const defaultResourceNotifyDeps: ResourceNotifyDeps = {
  recipients: resolvePodAdminUserIds,
  create: (input) => NotificationService.create(input),
  dismiss: async (metric) => {
    await db
      .update(notifications)
      .set({ status: NotificationStatus.DISMISSED })
      .where(
        and(
          eq(notifications.type, POD_RESOURCE_WARNING_TYPE),
          eq(notifications.groupKey, resourceWarningGroupKey(metric)),
          inArray(notifications.status, [
            NotificationStatus.UNREAD,
            NotificationStatus.SNOOZED,
          ])
        )
      );
  },
};

/**
 * Sends the plan's raises and clears. Returns what was done. Never throws:
 * a failed send is logged and counted, and the caller still persists the
 * plan's state (the next level, or the next episode, notifies again).
 */
export async function sendResourceNotifications(
  plan: Pick<NotificationPlan, "raise" | "clear">,
  deps: ResourceNotifyDeps = defaultResourceNotifyDeps
): Promise<{ sent: number; cleared: number; failed: number }> {
  let sent = 0;
  let cleared = 0;
  let failed = 0;
  let recipients: string[] = [];
  if (plan.raise.length > 0) {
    try {
      recipients = await deps.recipients();
    } catch (err) {
      logger.warn({ err }, "Could not resolve the pod admins to alert");
      failed += plan.raise.length;
    }
  }
  for (const alert of plan.raise) {
    for (const userId of recipients) {
      try {
        const id = await deps.create({
          type: POD_RESOURCE_WARNING_TYPE,
          userId,
          workspaceId: null,
          sourceType: "system",
          sourceId: `pod-resource:${alert.metric}:${alert.level}`,
          data: {
            metric: alert.metric,
            level: alert.level,
            headline: describeResourceAlert(alert.metric, alert.level),
            detail: DETAIL,
            ...(alert.value !== null ? { value: alert.value } : {}),
            ...(alert.since ? { since: alert.since } : {}),
          },
        });
        if (id) sent++;
      } catch (err) {
        failed++;
        logger.warn({ err, metric: alert.metric }, "Resource alert not sent");
      }
    }
  }
  for (const metric of plan.clear) {
    try {
      await deps.dismiss(metric);
      cleared++;
    } catch (err) {
      failed++;
      logger.warn({ err, metric }, "Resource alert not cleared");
    }
  }
  return { sent, cleared, failed };
}

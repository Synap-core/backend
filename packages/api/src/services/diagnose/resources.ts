/**
 * Diagnose's `resources` section — the pod's host and database resources
 * against their alert thresholds (plan P3, G10). It reads the SAME dry-run
 * evaluation the Pod health page reads (`services/pod-health`), so the row
 * on pod admin Home and the page it opens can never disagree.
 *
 * Pod admins only: host readings are the operator's, and a member's diagnose
 * gets no section at all (absent = not computed, never "fine").
 */

import { isPodAdmin } from "../../utils/workspace-role.js";
import {
  describeResourceAlert,
  openResourceAlerts,
  readPodHealth,
  type AlertLevel,
  type HostReadingsState,
} from "../pod-health/index.js";
import type { HealthSection } from "./types.js";

export type ResourcesSignal =
  | {
      available: true;
      level: AlertLevel;
      hostState: HostReadingsState;
      alerts: Array<{
        metric: string;
        level: Exclude<AlertLevel, "ok">;
        since: string | null;
        value: number | null;
      }>;
    }
  | { available: false };

/** Null = not computed (the caller is not a pod admin). Never throws. */
export async function gatherResourcesSignal(params: {
  userId: string;
}): Promise<ResourcesSignal | null> {
  try {
    if (!(await isPodAdmin(params.userId))) return null;
    const { evaluation } = await readPodHealth();
    return {
      available: true,
      level: evaluation.level,
      hostState: evaluation.hostState,
      alerts: openResourceAlerts(evaluation),
    };
  } catch {
    return { available: false };
  }
}

/** PURE: the section for a computed signal. */
export function summarizeResources(signal: ResourcesSignal): HealthSection {
  if (!signal.available) {
    return {
      key: "resources",
      status: "attention",
      headline: "Couldn’t read the pod’s resources",
      detail: { available: false },
    };
  }
  const status =
    signal.level === "critical"
      ? "degraded"
      : signal.level === "warning"
        ? "attention"
        : "ok";
  return {
    key: "resources",
    status,
    headline:
      signal.alerts.length === 0
        ? signal.hostState === "absent"
          ? // No host sampler yet: only the database was measured, and the
            // headline says so rather than vouching for memory and disks.
            "Database connections are within their limits; this pod’s host does not report memory or disks yet"
          : "Memory, disks and database connections are within their limits"
        : signal.alerts
            .map((a) => describeResourceAlert(a.metric, a.level))
            .join("; "),
    detail: {
      available: true,
      level: signal.level,
      hostState: signal.hostState,
      alerts: signal.alerts,
    },
  };
}

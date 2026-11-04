/**
 * Resource alert thresholds — `pod_settings.settings.resourceAlerts`, editable
 * by a pod admin on pod admin's Pod health page (plan P3, decision 8d8c2fef).
 *
 * Defaults (founder-validated, plan "pod resilience and resource alerts"):
 *   - percentages (memory, disk, Postgres connections): warn 80, critical 90;
 *     disk critical 95, and critical whatever its percentage when under 5 GB
 *     is free;
 *   - swap: warn 50, critical 80;
 *   - memory pressure (PSI "full", 60 s average): warn 10, critical 25.
 *
 * A stored blob is read PER FIELD: a malformed metric falls back to its
 * default, never makes the whole read fail and never reads as 0.
 */

export const THRESHOLD_METRICS = [
  "memory",
  "swap",
  "memoryPressure",
  "disk",
  "postgresConnections",
] as const;
export type ThresholdMetric = (typeof THRESHOLD_METRICS)[number];

export interface MetricThreshold {
  warn: number;
  critical: number;
}

export type ResourceAlertThresholds = Record<ThresholdMetric, MetricThreshold>;

export const RESOURCE_ALERTS_SETTING = "resourceAlerts" as const;

export const DEFAULT_RESOURCE_ALERT_THRESHOLDS: Readonly<ResourceAlertThresholds> =
  Object.freeze({
    memory: Object.freeze({ warn: 80, critical: 90 }),
    swap: Object.freeze({ warn: 50, critical: 80 }),
    memoryPressure: Object.freeze({ warn: 10, critical: 25 }),
    disk: Object.freeze({ warn: 80, critical: 95 }),
    postgresConnections: Object.freeze({ warn: 80, critical: 90 }),
  });

/** A disk under this much free space is critical whatever its percentage. */
export const DISK_CRITICAL_FREE_BYTES = 5 * 1024 ** 3;

/** An alert clears this many points below the threshold it crossed. */
export const HYSTERESIS_POINTS = 5;
/** The free-space rule clears once this much more than its floor is free. */
export const DISK_FREE_HYSTERESIS_BYTES = 1024 ** 3;

/** Consecutive samples over a threshold before the alert is raised (~5 min). */
export const SAMPLES_TO_RAISE = 3;

/** A host reading older than this is "readings stopped", never current. */
export const STALE_AFTER_MS = 10 * 60_000;

/** Why a threshold pair is refused, as a stable code (the page words it). */
export type ThresholdProblem =
  "not_a_number" | "out_of_range" | "warn_not_below_critical";

/** A pair is valid when both are in 1..100 and warn is strictly below critical. */
export function thresholdProblem(t: {
  warn: unknown;
  critical: unknown;
}): ThresholdProblem | null {
  const { warn, critical } = t;
  if (
    typeof warn !== "number" ||
    typeof critical !== "number" ||
    !Number.isFinite(warn) ||
    !Number.isFinite(critical)
  )
    return "not_a_number";
  if (warn < 1 || warn > 100 || critical < 1 || critical > 100)
    return "out_of_range";
  if (warn >= critical) return "warn_not_below_critical";
  return null;
}

/** The effective thresholds from the raw stored blob, per metric. */
export function resolveResourceAlertThresholds(
  raw: unknown
): ResourceAlertThresholds & { explicit: ThresholdMetric[] } {
  const stored =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const explicit: ThresholdMetric[] = [];
  const out = {} as ResourceAlertThresholds;
  for (const metric of THRESHOLD_METRICS) {
    const candidate = stored[metric] as Partial<MetricThreshold> | undefined;
    if (
      candidate &&
      typeof candidate === "object" &&
      thresholdProblem({
        warn: candidate.warn,
        critical: candidate.critical,
      }) === null
    ) {
      out[metric] = {
        warn: candidate.warn as number,
        critical: candidate.critical as number,
      };
      explicit.push(metric);
    } else {
      out[metric] = { ...DEFAULT_RESOURCE_ALERT_THRESHOLDS[metric] };
    }
  }
  return { ...out, explicit };
}

/**
 * Applies a patch (some metrics, each a full `{warn, critical}` pair) to the
 * current thresholds. Returns the problems per metric when any pair is
 * refused, so the page can show each beside its own field.
 */
export function applyThresholdsPatch(
  current: ResourceAlertThresholds,
  patch: Partial<Record<ThresholdMetric, { warn: number; critical: number }>>
):
  | { ok: true; thresholds: ResourceAlertThresholds }
  | {
      ok: false;
      problems: Partial<Record<ThresholdMetric, ThresholdProblem>>;
    } {
  const next: ResourceAlertThresholds = {
    memory: { ...current.memory },
    swap: { ...current.swap },
    memoryPressure: { ...current.memoryPressure },
    disk: { ...current.disk },
    postgresConnections: { ...current.postgresConnections },
  };
  const problems: Partial<Record<ThresholdMetric, ThresholdProblem>> = {};
  for (const metric of THRESHOLD_METRICS) {
    const pair = patch[metric];
    if (!pair) continue;
    const problem = thresholdProblem(pair);
    if (problem) problems[metric] = problem;
    else next[metric] = { warn: pair.warn, critical: pair.critical };
  }
  return Object.keys(problems).length > 0
    ? { ok: false, problems }
    : { ok: true, thresholds: next };
}

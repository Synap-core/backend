/**
 * The resource alert evaluator — PURE. One sample in, the next durable state
 * and the readings (each with its mark) out. The cron persists the state; the
 * Pod health page and diagnose run the same function as a dry run, so a mark
 * on the page and an alert in the bell come from ONE derivation.
 *
 * Rules (plan P3, decision 8d8c2fef):
 *   - an alert is raised after SAMPLES_TO_RAISE consecutive samples over its
 *     threshold (~5 min at the host's 2-min tick);
 *   - it clears HYSTERESIS_POINTS below the threshold it crossed (so a value
 *     hovering at the line does not flap);
 *   - a host file older than STALE_AFTER_MS, or one that cannot be read, is
 *     its own warning ("readings stopped"), and the host metrics keep their
 *     last level: an old reading is never re-counted as a new sample and never
 *     read as "all fine";
 *   - a block the host did not report is `unavailable`, never 0.
 *
 * Host metrics advance only on a NEW host sample (`sampledAt` changed); the
 * pod's own numbers (Postgres connections) advance on every evaluation.
 */

import type { BackupHealth } from "@synap/database";
import type { HostReadingsRead, HostResources } from "./host-readings.js";
import {
  DISK_CRITICAL_FREE_BYTES,
  DISK_FREE_HYSTERESIS_BYTES,
  HYSTERESIS_POINTS,
  SAMPLES_TO_RAISE,
  STALE_AFTER_MS,
  type MetricThreshold,
  type ResourceAlertThresholds,
} from "./thresholds.js";

export type AlertLevel = "ok" | "warning" | "critical";
/** A reading's mark: an alert level, `unavailable`, or `neutral` (shown, not judged). */
export type ReadingMark = AlertLevel | "unavailable" | "neutral";

const RANK: Record<AlertLevel, number> = { ok: 0, warning: 1, critical: 2 };

export function worseLevel(a: AlertLevel, b: AlertLevel): AlertLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

export function levelRank(level: AlertLevel): number {
  return RANK[level];
}

/** One alerting metric's durable state. */
export interface MetricAlertState {
  level: AlertLevel;
  /** When this episode left `ok`; null while ok. */
  since: string | null;
  /** Consecutive samples at or over the warn line (critical samples count). */
  overWarn: number;
  overCritical: number;
  /** The highest level already notified in this episode; null when none. */
  notified: Exclude<AlertLevel, "ok"> | null;
  /** The last value seen (null = unavailable). */
  value: number | null;
}

export interface ResourceAlertState {
  version: 1;
  /** The host sample the host metrics last advanced on. */
  hostSampledAt: string | null;
  evaluatedAt: string | null;
  metrics: Record<string, MetricAlertState>;
}

export const RESOURCE_ALERT_STATE_SETTING = "resourceAlertState" as const;

export function emptyAlertState(): ResourceAlertState {
  return { version: 1, hostSampledAt: null, evaluatedAt: null, metrics: {} };
}

function isLevel(v: unknown): v is AlertLevel {
  return v === "ok" || v === "warning" || v === "critical";
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** The durable state from its stored blob; a malformed blob starts over. */
export function parseAlertState(raw: unknown): ResourceAlertState {
  const r =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r || r.version !== 1) return emptyAlertState();
  const metrics: Record<string, MetricAlertState> = {};
  const m =
    r.metrics && typeof r.metrics === "object"
      ? (r.metrics as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(m)) {
    const s =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;
    if (!s || !isLevel(s.level)) continue;
    metrics[key] = {
      level: s.level,
      since: typeof s.since === "string" ? s.since : null,
      overWarn: count(s.overWarn),
      overCritical: count(s.overCritical),
      notified:
        s.notified === "warning" || s.notified === "critical"
          ? s.notified
          : null,
      value:
        typeof s.value === "number" && Number.isFinite(s.value)
          ? s.value
          : null,
    };
  }
  return {
    version: 1,
    hostSampledAt: typeof r.hostSampledAt === "string" ? r.hostSampledAt : null,
    evaluatedAt: typeof r.evaluatedAt === "string" ? r.evaluatedAt : null,
    metrics,
  };
}

function freshMetric(): MetricAlertState {
  return {
    level: "ok",
    since: null,
    overWarn: 0,
    overCritical: 0,
    notified: null,
    value: null,
  };
}

/** How a sample compares to its thresholds, raising and holding. */
export interface SampleTest {
  overWarn: boolean;
  overCritical: boolean;
  /** Still inside the hysteresis band of each line (clears below it). */
  holdsWarn: boolean;
  holdsCritical: boolean;
}

export function percentTest(value: number, t: MetricThreshold): SampleTest {
  return {
    overWarn: value >= t.warn,
    overCritical: value >= t.critical,
    holdsWarn: value >= t.warn - HYSTERESIS_POINTS,
    holdsCritical: value >= t.critical - HYSTERESIS_POINTS,
  };
}

/** A disk: its percentage, plus critical whenever under 5 GB is free. */
export function diskTest(
  usedPct: number,
  availBytes: number | null,
  t: MetricThreshold
): SampleTest {
  const p = percentTest(usedPct, t);
  const low = availBytes !== null && availBytes < DISK_CRITICAL_FREE_BYTES;
  const holdsLow =
    availBytes !== null &&
    availBytes < DISK_CRITICAL_FREE_BYTES + DISK_FREE_HYSTERESIS_BYTES;
  return {
    overWarn: p.overWarn || low,
    overCritical: p.overCritical || low,
    holdsWarn: p.holdsWarn || holdsLow,
    holdsCritical: p.holdsCritical || holdsLow,
  };
}

/**
 * One metric, one sample. `test` null = the value is unavailable this sample:
 * the streaks reset and the level is kept (an unknown is not a recovery).
 */
export function advanceMetric(
  prev: MetricAlertState | undefined,
  value: number | null,
  test: SampleTest | null,
  now: string
): MetricAlertState {
  const s = prev ?? freshMetric();
  if (value === null || test === null) {
    return { ...s, overWarn: 0, overCritical: 0, value: null };
  }
  const overWarn = test.overWarn ? s.overWarn + 1 : 0;
  const overCritical = test.overCritical ? s.overCritical + 1 : 0;
  const held: AlertLevel =
    s.level === "critical" && test.holdsCritical
      ? "critical"
      : s.level !== "ok" && test.holdsWarn
        ? "warning"
        : "ok";
  const raised: AlertLevel =
    overCritical >= SAMPLES_TO_RAISE
      ? "critical"
      : overWarn >= SAMPLES_TO_RAISE
        ? "warning"
        : "ok";
  const level = worseLevel(held, raised);
  return {
    level,
    since: level === "ok" ? null : s.level === "ok" ? now : s.since,
    overWarn,
    overCritical,
    notified: s.notified,
    value,
  };
}

/** Whether the host readings can be believed right now. */
export type HostReadingsState = "fresh" | "stale" | "unreadable" | "absent";

export function hostReadingsState(
  host: HostReadingsRead,
  now: Date
): HostReadingsState {
  if (host.read === "absent") return "absent";
  if (host.read === "unreadable") return "unreadable";
  const age = now.getTime() - Date.parse(host.resources.sampledAt);
  return age > STALE_AFTER_MS ? "stale" : "fresh";
}

/** The pod's own numbers, read by the backend itself. Null = unavailable. */
export interface PodOwnReadings {
  postgresConnections: { used: number; max: number } | null;
  databaseSizeBytes: number | null;
  /** Event-loop delay p99 over the rolling window (ms), from /health. */
  eventLoopP99Ms: number | null;
  backup: { status: BackupHealth; lastSuccessAt: string | null } | null;
}

export type ReadingKind =
  | "readings"
  | "memory"
  | "swap"
  | "memoryPressure"
  | "disk"
  | "postgresConnections"
  | "cpuPressure"
  | "ioPressure"
  | "load"
  | "databaseSize"
  | "eventLoop"
  | "backup";

export type ReadingUnit = "percent" | "bytes" | "ratio" | "ms" | "none";

export interface ResourceReading {
  /** Stable key: the alert metric key (`disk:data`) or the reading kind. */
  key: string;
  kind: ReadingKind;
  /** The disk's label (`data`, `docker`); absent elsewhere. */
  label?: string;
  value: number | null;
  unit: ReadingUnit;
  mark: ReadingMark;
  /** When an alert on it began (null when not alerting). */
  since: string | null;
  /** Whether a threshold judges it (and so whether it can raise an alert). */
  alerting: boolean;
  /** Reading-specific facts (bytes free, cores, backup status…). */
  detail: Record<string, unknown>;
}

export interface EvaluationInput {
  now: Date;
  host: HostReadingsRead;
  pod: PodOwnReadings;
  thresholds: ResourceAlertThresholds;
  previous: ResourceAlertState;
}

export interface Evaluation {
  state: ResourceAlertState;
  hostState: HostReadingsState;
  hostSampledAt: string | null;
  readings: ResourceReading[];
  /** The worst alert level across alerting metrics. */
  level: AlertLevel;
  /**
   * What the host actions would free (Docker build cache, unused release
   * images), from a FRESH sample only; null = unknown, never 0.
   */
  reclaimable: {
    buildCacheBytes: number | null;
    imagesReclaimableBytes: number | null;
    sampledAt: string | null;
  } | null;
}

const BACKUP_MARK: Record<BackupHealth, ReadingMark> = {
  ok: "ok",
  stale: "warning",
  failed: "critical",
  suspect: "critical",
  never: "unavailable",
};

function alertReading(
  key: string,
  kind: ReadingKind,
  s: MetricAlertState | undefined,
  value: number | null,
  unit: ReadingUnit,
  detail: Record<string, unknown> = {},
  label?: string
): ResourceReading {
  return {
    key,
    kind,
    ...(label ? { label } : {}),
    value,
    unit,
    mark: value === null ? "unavailable" : (s?.level ?? "ok"),
    since: s?.since ?? null,
    alerting: true,
    detail,
  };
}

function neutralReading(
  kind: ReadingKind,
  value: number | null,
  unit: ReadingUnit,
  detail: Record<string, unknown> = {}
): ResourceReading {
  return {
    key: kind,
    kind,
    value,
    unit,
    mark: value === null ? "unavailable" : "neutral",
    since: null,
    alerting: false,
    detail,
  };
}

/** One evaluation. Pure: the caller persists `state` (the cron) or not (a read). */
export function evaluateResources(input: EvaluationInput): Evaluation {
  const { now, host, pod, thresholds, previous } = input;
  const nowIso = now.toISOString();
  const metrics: Record<string, MetricAlertState> = { ...previous.metrics };
  const hostState = hostReadingsState(host, now);
  const res: HostResources | null = host.read === "ok" ? host.resources : null;

  // ── Readings stopped: its own warning, no hold (10 min IS the hold). ──
  const stopped = hostState === "stale" || hostState === "unreadable";
  const prevReadings = metrics.readings ?? freshMetric();
  metrics.readings = {
    ...prevReadings,
    level: stopped ? "warning" : "ok",
    since: stopped ? (prevReadings.since ?? nowIso) : null,
    overWarn: 0,
    overCritical: 0,
    value: null,
  };

  // ── Host metrics: only on a NEW, fresh sample. ──
  let hostSampledAt = previous.hostSampledAt;
  if (
    res &&
    hostState === "fresh" &&
    res.sampledAt !== previous.hostSampledAt
  ) {
    hostSampledAt = res.sampledAt;
    const mem = res.memory?.usedPct ?? null;
    metrics.memory = advanceMetric(
      metrics.memory,
      mem,
      mem === null ? null : percentTest(mem, thresholds.memory),
      nowIso
    );
    const swap = res.swap?.usedPct ?? null;
    metrics.swap = advanceMetric(
      metrics.swap,
      swap,
      swap === null ? null : percentTest(swap, thresholds.swap),
      nowIso
    );
    const psi = res.pressure.memory?.fullAvg60 ?? null;
    metrics.memoryPressure = advanceMetric(
      metrics.memoryPressure,
      psi,
      psi === null ? null : percentTest(psi, thresholds.memoryPressure),
      nowIso
    );
    const seen = new Set<string>();
    for (const d of res.disks) {
      const key = `disk:${d.label}`;
      seen.add(key);
      metrics[key] = advanceMetric(
        metrics[key],
        d.usedPct,
        diskTest(d.usedPct, d.availBytes, thresholds.disk),
        nowIso
      );
    }
    // A disk the host stopped reporting: unavailable, its level kept.
    for (const key of Object.keys(metrics)) {
      if (key.startsWith("disk:") && !seen.has(key)) {
        metrics[key] = advanceMetric(metrics[key], null, null, nowIso);
      }
    }
  }

  // ── The pod's own numbers: every evaluation is a sample. ──
  const pg = pod.postgresConnections;
  const pgPct =
    pg && pg.max > 0 ? Math.round((pg.used / pg.max) * 1000) / 10 : null;
  metrics.postgresConnections = advanceMetric(
    metrics.postgresConnections,
    pgPct,
    pgPct === null ? null : percentTest(pgPct, thresholds.postgresConnections),
    nowIso
  );

  // ── The readings, each with its mark. ──
  const fresh = hostState === "fresh" ? res : null;
  const readings: ResourceReading[] = [];
  readings.push({
    key: "readings",
    kind: "readings",
    value: null,
    unit: "none",
    mark: hostState === "absent" ? "unavailable" : stopped ? "warning" : "ok",
    since: metrics.readings.since,
    alerting: true,
    detail: {
      state: hostState,
      sampledAt: res?.sampledAt ?? null,
      hostKind: res?.hostKind ?? null,
      ...(host.read === "unreadable" ? { error: host.error } : {}),
    },
  });
  readings.push(
    alertReading(
      "memory",
      "memory",
      metrics.memory,
      fresh?.memory?.usedPct ?? null,
      "percent",
      {
        totalBytes: fresh?.memory?.totalBytes ?? null,
        availableBytes: fresh?.memory?.availableBytes ?? null,
      }
    ),
    alertReading(
      "memoryPressure",
      "memoryPressure",
      metrics.memoryPressure,
      fresh?.pressure.memory?.fullAvg60 ?? null,
      "percent",
      { someAvg60: fresh?.pressure.memory?.someAvg60 ?? null }
    ),
    alertReading(
      "swap",
      "swap",
      metrics.swap,
      fresh?.swap?.usedPct ?? null,
      "percent",
      {
        totalBytes: fresh?.swap?.totalBytes ?? null,
      }
    )
  );
  const diskLabels = new Set<string>([
    ...(fresh?.disks.map((d) => d.label) ?? []),
    ...Object.keys(metrics)
      .filter((k) => k.startsWith("disk:") && metrics[k]?.level !== "ok")
      .map((k) => k.slice(5)),
  ]);
  for (const label of diskLabels) {
    const d = fresh?.disks.find((x) => x.label === label) ?? null;
    readings.push(
      alertReading(
        `disk:${label}`,
        "disk",
        metrics[`disk:${label}`],
        d?.usedPct ?? null,
        "percent",
        {
          availBytes: d?.availBytes ?? null,
          totalBytes: d?.totalBytes ?? null,
        },
        label
      )
    );
  }
  readings.push(
    alertReading(
      "postgresConnections",
      "postgresConnections",
      metrics.postgresConnections,
      pgPct,
      "percent",
      { used: pg?.used ?? null, max: pg?.max ?? null }
    ),
    neutralReading(
      "cpuPressure",
      fresh?.pressure.cpu?.someAvg60 ?? null,
      "percent"
    ),
    neutralReading(
      "ioPressure",
      fresh?.pressure.io?.someAvg60 ?? null,
      "percent"
    ),
    neutralReading(
      "load",
      fresh?.load
        ? Math.round((fresh.load.avg1 / fresh.load.cores) * 100) / 100
        : null,
      "ratio",
      { avg1: fresh?.load?.avg1 ?? null, cores: fresh?.load?.cores ?? null }
    ),
    neutralReading("databaseSize", pod.databaseSizeBytes, "bytes"),
    neutralReading("eventLoop", pod.eventLoopP99Ms, "ms")
  );
  readings.push({
    key: "backup",
    kind: "backup",
    value: pod.backup?.lastSuccessAt
      ? Math.max(0, now.getTime() - Date.parse(pod.backup.lastSuccessAt))
      : null,
    unit: "ms",
    mark: pod.backup ? BACKUP_MARK[pod.backup.status] : "unavailable",
    since: null,
    alerting: false,
    detail: {
      status: pod.backup?.status ?? null,
      lastSuccessAt: pod.backup?.lastSuccessAt ?? null,
    },
  });

  const level = Object.values(metrics).reduce<AlertLevel>(
    (worst, m) => worseLevel(worst, m.level),
    "ok"
  );

  return {
    state: {
      version: 1,
      hostSampledAt,
      evaluatedAt: nowIso,
      metrics,
    },
    hostState,
    hostSampledAt: res?.sampledAt ?? null,
    readings,
    level,
    reclaimable: fresh?.docker
      ? {
          buildCacheBytes: fresh.docker.buildCacheBytes,
          imagesReclaimableBytes: fresh.docker.imagesReclaimableBytes,
          sampledAt: fresh.docker.sampledAt,
        }
      : null,
  };
}

// ── Notifications: once per metric and level, cleared when resolved. ──

export interface NotificationPlan {
  raise: Array<{
    metric: string;
    level: Exclude<AlertLevel, "ok">;
    value: number | null;
    since: string | null;
  }>;
  clear: string[];
  /** The state with `notified` advanced: persist it after sending. */
  state: ResourceAlertState;
}

/**
 * Which alerts to send and which to clear. An episode notifies once per
 * level it reaches (warning, then critical); going back down to warning
 * sends nothing; back to ok clears its notice and resets the episode.
 */
export function planNotifications(state: ResourceAlertState): NotificationPlan {
  const raise: NotificationPlan["raise"] = [];
  const clear: string[] = [];
  const metrics: Record<string, MetricAlertState> = {};
  for (const [key, m] of Object.entries(state.metrics)) {
    if (m.level === "ok") {
      if (m.notified) clear.push(key);
      metrics[key] = { ...m, notified: null };
      continue;
    }
    const already = m.notified ? RANK[m.notified] : 0;
    if (RANK[m.level] > already) {
      raise.push({
        metric: key,
        level: m.level,
        value: m.value,
        since: m.since,
      });
      metrics[key] = { ...m, notified: m.level };
    } else {
      metrics[key] = m;
    }
  }
  return { raise, clear, state: { ...state, metrics } };
}

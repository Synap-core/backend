/**
 * Pod health — the pure shaping of `podHealth.get` for the page. No React,
 * no fetch: the wire is narrowed here once (a malformed body is `null`, never
 * a guessed default), and every word the operator reads is decided here
 * through the folder's catalog, so the tests pin them.
 *
 * Wire shape: `packages/api/src/routers/pod-health.ts` (the evaluator is
 * `packages/api/src/services/pod-health/evaluate.ts`). The marks come from
 * the pod's ONE evaluator; this page never re-derives a level.
 */

import type { Locale, TFunction } from "@synap-core/types/i18n";
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  formatTime,
} from "@synap-core/types/value-format";
import { humanizeToken } from "@synap-core/types/vocabulary";
import type { StatusKind } from "../../components/status-pill";
import type { en } from "./copy";

type T = TFunction<typeof en>;

export type AlertLevel = "ok" | "warning" | "critical";
export type ReadingMark = AlertLevel | "unavailable" | "neutral";
export type HostState = "fresh" | "stale" | "unreadable" | "absent";

export const THRESHOLD_METRICS = [
  "memory",
  "swap",
  "memoryPressure",
  "disk",
  "postgresConnections",
] as const;
export type ThresholdMetric = (typeof THRESHOLD_METRICS)[number];
export type Thresholds = Record<
  ThresholdMetric,
  { warn: number; critical: number }
>;

export const HOST_ACTIONS = [
  "prune-build-cache",
  "prune-old-images",
  "restart-service",
] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];

export interface Reading {
  key: string;
  kind: string;
  label?: string;
  value: number | null;
  unit: "percent" | "bytes" | "ratio" | "ms" | "none";
  mark: ReadingMark;
  since: string | null;
  alerting: boolean;
  detail: Record<string, unknown>;
}

export interface OpenAlert {
  metric: string;
  level: Exclude<AlertLevel, "ok">;
  since: string | null;
  value: number | null;
}

export interface HostActionResult {
  id: string;
  action: HostAction;
  status: "done" | "refused" | "failed";
  detail: string | null;
  freedBytes: number | null;
  finishedAt: string | null;
}

export interface PodHealthView {
  level: AlertLevel;
  hostState: HostState;
  hostSampledAt: string | null;
  evaluatedAt: string | null;
  readings: Reading[];
  reclaimable: {
    buildCacheBytes: number | null;
    imagesReclaimableBytes: number | null;
  } | null;
  alerts: OpenAlert[];
  thresholds: Thresholds;
  actions: {
    pending: { id: string; action: HostAction; service?: string } | null;
    last:
      | { read: "ok"; result: HostActionResult }
      | { read: "absent" }
      | { read: "unreadable" }
      /** The host's dir is not the pod's yet (minutes after a deploy). */
      | { read: "not_ready" };
  };
  restartableServices: string[];
}

// ── The wire, narrowed ──────────────────────────────────────────────────────

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
const LEVELS = ["ok", "warning", "critical"] as const;
const MARKS = [...LEVELS, "unavailable", "neutral"] as const;
const HOST_STATES = ["fresh", "stale", "unreadable", "absent"] as const;
const UNITS = ["percent", "bytes", "ratio", "ms", "none"] as const;
function oneOf<T extends string>(v: unknown, all: readonly T[]): T | null {
  return typeof v === "string" && (all as readonly string[]).includes(v)
    ? (v as T)
    : null;
}

function parseReading(v: unknown): Reading | null {
  const r = obj(v);
  const key = str(r?.key);
  const kind = str(r?.kind);
  const mark = oneOf(r?.mark, MARKS);
  const unit = oneOf(r?.unit, UNITS);
  if (!r || !key || !kind || !mark || !unit) return null;
  return {
    key,
    kind,
    ...(str(r.label) ? { label: str(r.label) as string } : {}),
    value: num(r.value),
    unit,
    mark,
    since: str(r.since),
    alerting: r.alerting === true,
    detail: obj(r.detail) ?? {},
  };
}

function parseThresholds(v: unknown): Thresholds | null {
  const o = obj(v);
  if (!o) return null;
  const out = {} as Thresholds;
  for (const m of THRESHOLD_METRICS) {
    const p = obj(o[m]);
    const warn = num(p?.warn);
    const critical = num(p?.critical);
    if (warn === null || critical === null) return null;
    out[m] = { warn, critical };
  }
  return out;
}

function parseResult(v: unknown): HostActionResult | null {
  const r = obj(v);
  const id = str(r?.id);
  const action = oneOf(r?.action, HOST_ACTIONS);
  const status = oneOf(r?.status, ["done", "refused", "failed"] as const);
  if (!r || !id || !action || !status) return null;
  return {
    id,
    action,
    status,
    detail: str(r.detail),
    freedBytes: num(r.freedBytes),
    finishedAt: str(r.finishedAt),
  };
}

/** The page's view from the procedure's answer, or null when it is not the contract. */
export function parsePodHealth(body: unknown): PodHealthView | null {
  const b = obj(body);
  if (!b) return null;
  const level = oneOf(b.level, LEVELS);
  const hostState = oneOf(b.hostState, HOST_STATES);
  const thresholds = parseThresholds(b.thresholds);
  const actions = obj(b.actions);
  if (!level || !hostState || !thresholds || !actions) return null;
  if (!Array.isArray(b.readings) || !Array.isArray(b.alerts)) return null;
  const pending = obj(actions.pending);
  const pendingAction = oneOf(pending?.action, HOST_ACTIONS);
  const last = obj(actions.last);
  const lastResult = last?.read === "ok" ? parseResult(last.result) : null;
  const reclaimable = obj(b.reclaimable);
  return {
    level,
    hostState,
    hostSampledAt: str(b.hostSampledAt),
    evaluatedAt: str(b.evaluatedAt),
    readings: b.readings
      .map(parseReading)
      .filter((r): r is Reading => r !== null),
    reclaimable: reclaimable
      ? {
          buildCacheBytes: num(reclaimable.buildCacheBytes),
          imagesReclaimableBytes: num(reclaimable.imagesReclaimableBytes),
        }
      : null,
    alerts: b.alerts.flatMap((a): OpenAlert[] => {
      const o = obj(a);
      const metric = str(o?.metric);
      const lvl = oneOf(o?.level, ["warning", "critical"] as const);
      return o && metric && lvl
        ? [{ metric, level: lvl, since: str(o.since), value: num(o.value) }]
        : [];
    }),
    thresholds,
    actions: {
      pending:
        pending && str(pending.id) && pendingAction
          ? {
              id: str(pending.id) as string,
              action: pendingAction,
              ...(str(pending.service)
                ? { service: str(pending.service) as string }
                : {}),
            }
          : null,
      last:
        last?.read === "ok" && lastResult
          ? { read: "ok", result: lastResult }
          : last?.read === "absent"
            ? { read: "absent" }
            : last?.read === "not_ready"
              ? { read: "not_ready" }
              : { read: "unreadable" },
    },
    restartableServices: Array.isArray(b.restartableServices)
      ? b.restartableServices.filter((s): s is string => typeof s === "string")
      : [],
  };
}

// ── Words ───────────────────────────────────────────────────────────────────

/** A mark's tone on the shared status palette; `neutral` has none. */
export function markTone(mark: ReadingMark): StatusKind | null {
  switch (mark) {
    case "ok":
      return "healthy";
    case "warning":
      return "stale";
    case "critical":
      return "down";
    case "unavailable":
      return "unknown";
    default:
      return null;
  }
}

export function markLabel(t: T, mark: ReadingMark): string | null {
  if (mark === "neutral") return null;
  return t(`mark.${mark}`);
}

/** A disk's name: "The data disk", or the humanized label of another. */
export function diskName(t: T, label: string): string {
  if (label === "data") return t("disk.data");
  if (label === "docker") return t("disk.docker");
  return t("disk.other", { label: humanizeToken(label) });
}

/** A service's name in people's words (the backend's token humanized otherwise). */
export function serviceName(t: T, service: string): string {
  switch (service) {
    case "backend":
      return t("service.backend");
    case "realtime":
      return t("service.realtime");
    case "pod-admin":
      return t("service.pod-admin");
    case "typesense":
      return t("service.typesense");
    case "browserless":
      return t("service.browserless");
    case "rsshub":
      return t("service.rsshub");
    default:
      return humanizeToken(service);
  }
}

/** "22:40" today, "3 Nov · 22:40" another day. */
export function sinceTime(
  iso: string | null,
  locale: Locale,
  now: number = Date.now()
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(now).toDateString() === d.toDateString()
    ? formatTime(d, { locale })
    : formatDateTime(d, now, { locale });
}

const RANK: Record<"warning" | "critical", number> = {
  warning: 1,
  critical: 2,
};

/**
 * The one sentence at the top: "All good", or the worst open alert with
 * since when ("Memory pressure is high since 22:40"); `more` counts the
 * other open alerts (its own message, shown beside it, never glued on).
 */
export function stateSentence(
  t: T,
  view: Pick<PodHealthView, "alerts" | "hostState" | "hostSampledAt">,
  locale: Locale,
  now: number = Date.now()
): { sentence: string; more: string | null } {
  const alerts = [...view.alerts].sort((a, b) => RANK[b.level] - RANK[a.level]);
  const worst = alerts[0];
  if (!worst) {
    return {
      sentence:
        view.hostState === "absent" ? t("state.okNoHost") : t("state.ok"),
      more: null,
    };
  }
  const time = sinceTime(worst.since, locale, now);
  return {
    sentence: alertSentence(t, worst, time, view, locale, now),
    more: alerts.length > 1 ? t("state.more", { n: alerts.length - 1 }) : null,
  };
}

function alertSentence(
  t: T,
  a: OpenAlert,
  time: string,
  view: Pick<PodHealthView, "hostState" | "hostSampledAt">,
  locale: Locale,
  now: number
): string {
  const crit = a.level === "critical";
  if (a.metric.startsWith("disk:")) {
    const disk = diskName(t, a.metric.slice(5));
    return crit
      ? t("state.disk.critical", { disk, time })
      : t("state.disk.warning", { disk, time });
  }
  switch (a.metric) {
    case "memory":
      return crit
        ? t("state.memory.critical", { time })
        : t("state.memory.warning", { time });
    case "swap":
      return crit
        ? t("state.swap.critical", { time })
        : t("state.swap.warning", { time });
    case "memoryPressure":
      return crit
        ? t("state.memoryPressure.critical", { time })
        : t("state.memoryPressure.warning", { time });
    case "postgresConnections":
      return crit
        ? t("state.postgresConnections.critical", { time })
        : t("state.postgresConnections.warning", { time });
    case "readings":
      return view.hostState === "unreadable"
        ? t("state.readings.unreadable")
        : t("state.readings.stale", {
            time: sinceTime(view.hostSampledAt, locale, now),
          });
    default:
      return crit
        ? t("state.other.critical", { time })
        : t("state.other.warning", { time });
  }
}

/** One reading as a row: its name, its value, one line of detail, its mark. */
export interface ReadingRow {
  key: string;
  name: string;
  value: string | null;
  detail: string | null;
  mark: ReadingMark;
  markLabel: string | null;
  tone: StatusKind | null;
}

function percent(t: T, n: number, locale: Locale): string {
  return t("value.percent", {
    n: formatNumber(n, { locale, maximumFractionDigits: 1 }),
  });
}

function bytes(v: unknown, locale: Locale): string | null {
  const n = num(v);
  return n === null ? null : formatBytes(n, { locale });
}

function readingName(t: T, r: Reading): string {
  switch (r.kind) {
    case "disk":
      return t("reading.disk", { disk: diskName(t, r.label ?? "data") });
    case "readings":
    case "memory":
    case "swap":
    case "memoryPressure":
    case "postgresConnections":
    case "cpuPressure":
    case "ioPressure":
    case "load":
    case "databaseSize":
    case "eventLoop":
    case "backup":
      return t(`reading.${r.kind}`);
    default:
      return humanizeToken(r.kind);
  }
}

function readingValue(t: T, r: Reading, locale: Locale): string | null {
  if (r.value === null) return null;
  switch (r.unit) {
    case "percent":
      return percent(t, r.value, locale);
    case "bytes":
      return formatBytes(r.value, { locale });
    case "ratio":
      return t("value.perCore", {
        n: formatNumber(r.value, { locale, maximumFractionDigits: 2 }),
      });
    case "ms":
      // The backup's value is its age; its detail says it in words.
      return r.kind === "backup" ? null : formatDuration(r.value, { locale });
    default:
      return null;
  }
}

function readingDetail(
  t: T,
  r: Reading,
  locale: Locale,
  now: number
): string | null {
  const d = r.detail;
  const when = (iso: unknown) =>
    typeof iso === "string" ? formatRelative(iso, now, { locale }) : "";
  switch (r.kind) {
    case "readings": {
      const state = oneOf(d.state, HOST_STATES);
      if (state === "absent") return t("detail.readings.absent");
      if (state === "unreadable") return t("detail.readings.unreadable");
      return state === "stale"
        ? t("detail.readings.stale", { when: when(d.sampledAt) })
        : t("detail.readings.fresh", { when: when(d.sampledAt) });
    }
    case "memory": {
      const available = bytes(d.availableBytes, locale);
      const total = bytes(d.totalBytes, locale);
      return r.value !== null && available && total
        ? t("detail.memory", { available, total })
        : null;
    }
    case "swap": {
      const total = bytes(d.totalBytes, locale);
      return r.value !== null && total ? t("detail.swap", { total }) : null;
    }
    case "disk": {
      const free = bytes(d.availBytes, locale);
      const total = bytes(d.totalBytes, locale);
      return r.value !== null && free && total
        ? t("detail.disk", { free, total })
        : null;
    }
    case "postgresConnections": {
      const used = num(d.used);
      const max = num(d.max);
      return used !== null && max !== null
        ? t("detail.postgres", {
            used: formatNumber(used, { locale }),
            max: formatNumber(max, { locale }),
          })
        : null;
    }
    case "memoryPressure":
      return r.value !== null ? t("detail.memoryPressure") : null;
    case "cpuPressure":
      return r.value !== null ? t("detail.cpuPressure") : null;
    case "ioPressure":
      return r.value !== null ? t("detail.ioPressure") : null;
    case "load": {
      const cores = num(d.cores);
      return r.value !== null && cores !== null
        ? t("detail.load", { cores })
        : null;
    }
    case "eventLoop":
      return r.value !== null ? t("detail.eventLoop") : null;
    case "backup": {
      const status = str(d.status);
      if (status === "never" || !status) return t("detail.backup.never");
      if (status === "failed" || status === "suspect")
        return t("detail.backup.failed");
      return status === "stale"
        ? t("detail.backup.stale", { when: when(d.lastSuccessAt) })
        : t("detail.backup.ok", { when: when(d.lastSuccessAt) });
    }
    default:
      return null;
  }
}

/**
 * The readings as rows, alerting ones first (worst first), the readings
 * row only when it has something to say (stopped, absent, unreadable).
 */
export function readingRows(
  t: T,
  view: Pick<PodHealthView, "readings" | "thresholds">,
  locale: Locale,
  now: number = Date.now()
): ReadingRow[] {
  const order: Record<ReadingMark, number> = {
    critical: 0,
    warning: 1,
    ok: 2,
    neutral: 3,
    unavailable: 4,
  };
  return view.readings
    .filter((r) => r.kind !== "readings" || r.mark !== "ok")
    .map((r, i) => ({ r, i }))
    .sort((a, b) => order[a.r.mark] - order[b.r.mark] || a.i - b.i)
    .map(({ r }) => ({
      key: r.key,
      name: readingName(t, r),
      value: readingValue(t, r, locale),
      detail: readingDetail(t, r, locale, now),
      mark: r.mark,
      markLabel: markLabel(t, r.mark),
      tone: markTone(r.mark),
    }));
}

// ── Actions: only those that help the current alerts ────────────────────────

export type ActionCard =
  | { kind: "pause" }
  | { kind: "host"; action: "prune-build-cache"; freesBytes: number | null }
  | { kind: "host"; action: "prune-old-images"; freesBytes: number | null }
  | { kind: "restart"; services: string[] }
  | { kind: "readings" };

/**
 * The host trims Docker's build cache DOWN TO this much (backend#746,
 * `_ue_cap_build_cache`), so it frees what is above it.
 */
export const BUILD_CACHE_KEEP_BYTES = 2 * 1024 ** 3;

/**
 * Which actions help, from the open alerts. Memory, swap and pressure: pause
 * what runs, or restart a service. Database connections: pause, or restart
 * (the API holds them). A disk: trim the build cache, remove old images.
 * Readings stopped: what to run on the host. Nothing open: no actions.
 */
export function actionsFor(
  view: Pick<PodHealthView, "alerts" | "reclaimable" | "restartableServices">
): ActionCard[] {
  const metrics = new Set(view.alerts.map((a) => a.metric));
  const memory = ["memory", "swap", "memoryPressure"].some((m) =>
    metrics.has(m)
  );
  const connections = metrics.has("postgresConnections");
  const disk = [...metrics].some((m) => m.startsWith("disk:"));
  const cards: ActionCard[] = [];
  if (memory || connections) cards.push({ kind: "pause" });
  if (disk) {
    // What each frees, when the host measured it; an action that would free
    // nothing is not offered, an unmeasured one is (its size unknown).
    const cache = view.reclaimable?.buildCacheBytes ?? null;
    const cacheFrees =
      cache === null ? null : Math.max(0, cache - BUILD_CACHE_KEEP_BYTES);
    const images = view.reclaimable?.imagesReclaimableBytes ?? null;
    if (cacheFrees !== 0)
      cards.push({
        kind: "host",
        action: "prune-build-cache",
        freesBytes: cacheFrees,
      });
    if (images !== 0)
      cards.push({
        kind: "host",
        action: "prune-old-images",
        freesBytes: images,
      });
  }
  if ((memory || connections) && view.restartableServices.length > 0) {
    cards.push({ kind: "restart", services: view.restartableServices });
  }
  if (metrics.has("readings")) cards.push({ kind: "readings" });
  return cards;
}

/** The host's answer for this action, as one line, or null when none. */
export function actionResultLine(
  t: T,
  action: HostAction,
  view: Pick<PodHealthView, "actions">,
  locale: Locale,
  now: number = Date.now()
): { text: string; tone: StatusKind } | null {
  const { pending, last } = view.actions;
  if (pending?.action === action)
    return { text: t("result.pending"), tone: "unknown" };
  // The host's answers cannot be read: said once per action card, never
  // read as "nothing happened".
  if (last.read === "not_ready")
    return { text: t("result.notReady"), tone: "unknown" };
  if (last.read === "unreadable")
    return { text: t("result.unreadable"), tone: "stale" };
  if (last.read !== "ok" || last.result.action !== action) return null;
  const r = last.result;
  const when = r.finishedAt
    ? formatRelative(r.finishedAt, now, { locale })
    : "";
  if (r.status === "done") {
    return {
      text:
        r.freedBytes !== null && r.freedBytes > 0
          ? t("result.doneFreed", {
              when,
              bytes: formatBytes(r.freedBytes, { locale }),
            })
          : t("result.done", { when }),
      tone: "healthy",
    };
  }
  return r.status === "refused"
    ? { text: t("result.refused", { when }), tone: "stale" }
    : { text: t("result.failed", { when }), tone: "down" };
}

/** Why a requestAction refusal happened, in words. */
export function actionErrorText(t: T, message: string | undefined): string {
  if (message === "busy") return t("error.busy");
  if (message === "unavailable") return t("error.unavailable");
  if (message === "not_ready") return t("error.notReady");
  return t("error.generic");
}

// ── Thresholds form ─────────────────────────────────────────────────────────

export type ThresholdDraft = Record<
  ThresholdMetric,
  { warn: string; critical: string }
>;
export type ThresholdProblem =
  "not_a_number" | "out_of_range" | "warn_not_below_critical";

export function draftFrom(t: Thresholds): ThresholdDraft {
  const out = {} as ThresholdDraft;
  for (const m of THRESHOLD_METRICS)
    out[m] = { warn: String(t[m].warn), critical: String(t[m].critical) };
  return out;
}

/**
 * The same rule the pod enforces (`thresholdProblem`, services/pod-health/
 * thresholds.ts): both 1..100, warn strictly below critical. Checked here
 * first so each field shows its own problem; the pod stays the authority.
 */
export function checkThresholdDraft(draft: ThresholdDraft):
  | { ok: true; patch: Thresholds }
  | {
      ok: false;
      problems: Partial<Record<ThresholdMetric, ThresholdProblem>>;
    } {
  const problems: Partial<Record<ThresholdMetric, ThresholdProblem>> = {};
  const patch = {} as Thresholds;
  for (const m of THRESHOLD_METRICS) {
    const warnText = draft[m].warn.trim().replace(",", ".");
    const critText = draft[m].critical.trim().replace(",", ".");
    const warn = warnText === "" ? NaN : Number(warnText);
    const critical = critText === "" ? NaN : Number(critText);
    if (!Number.isFinite(warn) || !Number.isFinite(critical))
      problems[m] = "not_a_number";
    else if (warn < 1 || warn > 100 || critical < 1 || critical > 100)
      problems[m] = "out_of_range";
    else if (warn >= critical) problems[m] = "warn_not_below_critical";
    else patch[m] = { warn, critical };
  }
  return Object.keys(problems).length > 0
    ? { ok: false, problems }
    : { ok: true, patch };
}

export function metricName(t: T, m: ThresholdMetric): string {
  return m === "disk" ? t("thresholds.disks") : t(`reading.${m}`);
}

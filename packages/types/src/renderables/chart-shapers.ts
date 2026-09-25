/**
 * Chart shapers — entities → the data a chart cell draws. The ONE
 * implementation, shared by the browser's live chart (`useChartSeries`,
 * @synap-core/hooks), its "Freeze", and the server-side freeze of AI-written
 * report charts (`document.freeze_charts`), so a frozen snapshot is exactly
 * what the live chart draws from the same rows. (Moved from bento's
 * `chart-data.ts`; a tripwire keeps it the only copy.)
 *
 * Each chart key has one shaper, typed against `CHART_DATA_SHAPE_BY_KEY`: the
 * `satisfies` below fails the build when a chart key has no shaper, or when a
 * shaper returns a different shape than the catalog says the chart draws.
 *
 * Pure: no React, no client, no DB. `now` is injected (bucket boundaries).
 * Known environment dependence: day buckets and bucket labels use the RUNTIME's
 * local timezone / locale (`setHours`, `toLocaleDateString`), so a server
 * freeze (UTC) and a browser in another timezone can bucket a boundary row
 * differently; counts over the whole window are identical.
 */

import type {
  ChartCategoryPoint,
  ChartCellKey,
  ChartComposedPoint,
  ChartDataFor,
  ChartFlow,
  ChartRegions,
  ChartSeriesPoint,
  ChartXYPoint,
} from "./chart-data.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEntity = Record<string, any>;
type ChartConfig = Record<string, unknown>;

export type ChartTimePeriod = "day" | "week" | "month";
export type ChartAggregation = "count" | "sum" | "avg" | "min" | "max";
export type ScalarAggregation = "count" | "sum" | "avg" | "completion";
export type RegionAggregation = "count" | "sum" | "avg";

// ─── Config readers (the defaults every chart cell used to re-declare) ────────

const AGGREGATIONS: readonly ChartAggregation[] = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
];
const SCALAR_AGGREGATIONS: readonly ScalarAggregation[] = [
  "count",
  "sum",
  "avg",
  "completion",
];
const REGION_AGGREGATIONS: readonly RegionAggregation[] = [
  "count",
  "sum",
  "avg",
];
const PERIODS: readonly ChartTimePeriod[] = ["day", "week", "month"];

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// ─── Time buckets ─────────────────────────────────────────────────────────────

interface TimeBucket {
  start: number;
  end: number;
}

const BUCKET_COUNT: Record<ChartTimePeriod, number> = {
  day: 14,
  week: 12,
  month: 12,
};

function getTimeBuckets(period: ChartTimePeriod, now: Date): TimeBucket[] {
  const count = BUCKET_COUNT[period];
  const buckets: TimeBucket[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(now);
    const end = new Date(now);

    switch (period) {
      case "day":
        start.setDate(start.getDate() - i);
        start.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() - i);
        end.setHours(23, 59, 59, 999);
        break;
      case "week":
        end.setDate(end.getDate() - i * 7);
        start.setDate(start.getDate() - (i + 1) * 7);
        break;
      case "month":
        end.setMonth(end.getMonth() - i);
        start.setMonth(start.getMonth() - i - 1);
        break;
    }
    buckets.push({ start: start.getTime(), end: end.getTime() });
  }
  return buckets;
}

function entityTimestamp(e: AnyEntity): number | null {
  const created = e?.createdAt ?? e?.metadata?.createdAt;
  if (!created) return null;
  const ts = new Date(created).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function readField(e: AnyEntity, field: string): unknown {
  return e?.properties?.[field] ?? e?.metadata?.[field];
}

function numericField(e: AnyEntity, field: string): number | null {
  const num = Number(readField(e, field));
  return Number.isNaN(num) ? null : num;
}

function aggregate(values: number[], aggregation: ChartAggregation): number {
  if (aggregation === "count") return values.length;
  if (values.length === 0) return 0;
  switch (aggregation) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
}

export interface BuildSeriesOptions {
  timePeriod: ChartTimePeriod;
  /** Property to aggregate (required for sum/avg/min/max; ignored for count) */
  valueField?: string;
  aggregation: ChartAggregation;
  /** Reference "now" for the buckets (tests pin it). */
  now?: Date;
}

/**
 * Bucket `entities` by creation time into `{ x, y }` points (x = the bucket's
 * ISO start), each `y` the aggregation of the bucket's entities.
 */
export function buildSeries(
  entities: AnyEntity[],
  { timePeriod, valueField, aggregation, now = new Date() }: BuildSeriesOptions
): ChartSeriesPoint[] {
  const buckets = getTimeBuckets(timePeriod, now);
  const grouped: number[][] = buckets.map(() => []);

  for (const e of entities) {
    const ts = entityTimestamp(e);
    if (ts === null) continue;
    const idx = buckets.findIndex((b) => ts >= b.start && ts <= b.end);
    if (idx === -1) continue;

    if (aggregation === "count") {
      grouped[idx].push(1);
    } else if (valueField) {
      const v = numericField(e, valueField);
      if (v !== null) grouped[idx].push(v);
    }
  }

  return buckets.map((b, i) => ({
    x: new Date(b.start).toISOString(),
    y: aggregate(grouped[i], aggregation),
  }));
}

/** The short month/day label of a bucket (categorical x for bars). */
function bucketLabel(iso: string | number): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Two aggregations per time bucket — bars + a line (the composed chart). */
export function buildComposedSeries(
  entities: AnyEntity[],
  opts: {
    timePeriod: ChartTimePeriod;
    barAggregation: ChartAggregation;
    barField?: string;
    lineAggregation: ChartAggregation;
    lineField?: string;
    now?: Date;
  }
): ChartComposedPoint[] {
  const bars = buildSeries(entities, {
    timePeriod: opts.timePeriod,
    valueField: opts.barField,
    aggregation: opts.barAggregation,
    now: opts.now,
  });
  const lines = buildSeries(entities, {
    timePeriod: opts.timePeriod,
    valueField: opts.lineField,
    aggregation: opts.lineAggregation,
    now: opts.now,
  });
  return bars.map((b, i) => ({
    x: bucketLabel(b.x),
    bar: b.y,
    line: lines[i]?.y ?? 0,
  }));
}

/**
 * Count entities per distinct value of `groupByField` — most frequent first,
 * capped. Feeds bar / pie / funnel.
 */
export function buildDistribution(
  entities: AnyEntity[],
  {
    groupByField,
    maxCategories = 8,
  }: { groupByField: string; maxCategories?: number }
): ChartCategoryPoint[] {
  if (!groupByField) return [];
  const groups: Record<string, number> = {};
  for (const e of entities) {
    const raw = readField(e, groupByField);
    const key = raw != null && raw !== "" ? String(raw) : "—";
    groups[key] = (groups[key] ?? 0) + 1;
  }
  return Object.entries(groups)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCategories)
    .map(([label, value]) => ({ label, value }));
}

const DEFAULT_DONE_VALUES = [
  "done",
  "completed",
  "closed",
  "closed-won",
  "read",
  "finished",
];

/**
 * Reduce `entities` to ONE number (gauge / ring). `completion` = % (0–100) of
 * entities whose `completionField` is a done value; count = entity count;
 * sum/avg reduce `valueField`. The cell normalizes the raw number for display.
 */
export function buildScalar(
  entities: AnyEntity[],
  {
    aggregation,
    valueField,
    completionField = "status",
    doneValues = DEFAULT_DONE_VALUES,
  }: {
    aggregation: ScalarAggregation;
    valueField?: string;
    completionField?: string;
    doneValues?: string[];
  }
): number {
  if (aggregation === "count") return entities.length;

  if (aggregation === "completion") {
    if (entities.length === 0) return 0;
    const done = entities.filter((e) => {
      const val = String(readField(e, completionField) ?? "").toLowerCase();
      return doneValues.includes(val);
    }).length;
    return Math.round((done / entities.length) * 100);
  }

  if (!valueField) return 0;
  const values = entities
    .map((e) => numericField(e, valueField))
    .filter((v): v is number => v !== null);
  if (values.length === 0) return 0;
  const total = values.reduce((a, b) => a + b, 0);
  return aggregation === "avg" ? total / values.length : total;
}

/**
 * One radar axis per metric property: that property aggregated across all
 * entities (sum/avg/min/max, or a non-empty count).
 */
export function buildAxes(
  entities: AnyEntity[],
  { metrics, aggregation }: { metrics: string[]; aggregation: ChartAggregation }
): ChartCategoryPoint[] {
  if (!metrics || metrics.length === 0) return [];
  return metrics.map((field) => {
    if (aggregation === "count") {
      const present = entities.filter((e) => {
        const raw = readField(e, field);
        return raw != null && raw !== "";
      }).length;
      return { label: field, value: present };
    }
    const values = entities
      .map((e) => numericField(e, field))
      .filter((v): v is number => v !== null);
    return { label: field, value: aggregate(values, aggregation) };
  });
}

/** Each entity → `{ x, y, label }` from two numeric properties (scatter). */
export function buildPoints(
  entities: AnyEntity[],
  {
    xField,
    yField,
    labelField,
  }: { xField: string; yField: string; labelField?: string }
): ChartXYPoint[] {
  if (!xField || !yField) return [];
  const points: ChartXYPoint[] = [];
  for (const e of entities) {
    const x = Number(readField(e, xField));
    const y = Number(readField(e, yField));
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    const labelRaw = labelField
      ? readField(e, labelField)
      : (e?.title ?? e?.name ?? e?.properties?.title);
    points.push({
      x,
      y,
      ...(labelRaw != null ? { label: String(labelRaw) } : {}),
    });
  }
  return points;
}

/**
 * Entities → a sankey flow graph. Node ids are SIDE-PREFIXED ("src:" / "tgt:")
 * so a value on both sides stays two nodes — d3-sankey needs an acyclic id
 * space. Labels keep the raw value.
 */
export function buildFlow(
  entities: AnyEntity[],
  { sourceField, targetField }: { sourceField: string; targetField: string }
): ChartFlow {
  if (!sourceField || !targetField) return { nodes: [], links: [] };

  const linkCounts: Record<string, number> = {};
  const nodeLabels: Record<string, string> = {};

  for (const e of entities) {
    const rawSrc = readField(e, sourceField);
    const rawTgt = readField(e, targetField);
    const srcVal = rawSrc != null && rawSrc !== "" ? String(rawSrc) : "—";
    const tgtVal = rawTgt != null && rawTgt !== "" ? String(rawTgt) : "—";

    const srcId = `src:${srcVal}`;
    const tgtId = `tgt:${tgtVal}`;
    nodeLabels[srcId] = srcVal;
    nodeLabels[tgtId] = tgtVal;

    const key = `${srcId} ${tgtId}`;
    linkCounts[key] = (linkCounts[key] ?? 0) + 1;
  }

  return {
    nodes: Object.entries(nodeLabels).map(([id, label]) => ({ id, label })),
    links: Object.entries(linkCounts).map(([key, value]) => {
      const [source, target] = key.split(" ");
      return { source, target, value };
    }),
  };
}

/**
 * Entities → `{ region → value }` (choropleth). Keys pass through unchanged;
 * matching against the world map happens in ChoroplethChart.
 */
export function buildRegionValues(
  entities: AnyEntity[],
  {
    regionField,
    aggregation,
    valueField,
  }: {
    regionField: string;
    aggregation: RegionAggregation;
    valueField?: string;
  }
): ChartRegions {
  if (!regionField) return {};

  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};

  for (const e of entities) {
    const rawRegion = readField(e, regionField);
    if (rawRegion == null || rawRegion === "") continue;
    const region = String(rawRegion);

    counts[region] = (counts[region] ?? 0) + 1;

    if (aggregation !== "count" && valueField) {
      const num = Number(readField(e, valueField));
      if (!Number.isNaN(num)) sums[region] = (sums[region] ?? 0) + num;
    }
  }

  if (aggregation === "count") return counts;

  const result: ChartRegions = {};
  for (const region of Object.keys(counts)) {
    const total = sums[region] ?? 0;
    result[region] = aggregation === "avg" ? total / counts[region] : total;
  }
  return result;
}

// ─── One shaper per chart key ────────────────────────────────────────────────

type Shaper<K extends ChartCellKey> = (
  entities: AnyEntity[],
  config: ChartConfig,
  now: Date
) => ChartDataFor<K>;

function timeSeries(defaultAggregation: ChartAggregation) {
  return (
    entities: AnyEntity[],
    config: ChartConfig,
    now: Date
  ): ChartSeriesPoint[] =>
    buildSeries(entities, {
      timePeriod: pick(config.timePeriod, PERIODS, "week"),
      valueField: str(config.valueField),
      aggregation: pick(config.aggregation, AGGREGATIONS, defaultAggregation),
      now,
    });
}

function scalar(entities: AnyEntity[], config: ChartConfig): number {
  return buildScalar(entities, {
    aggregation: pick(config.aggregation, SCALAR_AGGREGATIONS, "completion"),
    valueField: str(config.valueField),
  });
}

export const CHART_QUERY_SHAPERS = {
  "chart-line": timeSeries("count"),
  "chart-area": timeSeries("count"),
  "chart-live-line": timeSeries("count"),
  "chart-profit-loss": timeSeries("sum"),
  "chart-bar": (entities, config, now) => {
    if (config.mode === "trend") {
      // The time-bucket series, re-labelled as categories for the bars.
      return timeSeries("count")(entities, config, now).map((p) => ({
        label: bucketLabel(p.x),
        value: p.y,
      }));
    }
    const groupBy = str(config.groupBy);
    return groupBy
      ? buildDistribution(entities, { groupByField: groupBy })
      : [];
  },
  "chart-pie": (entities, config) => {
    const groupBy = str(config.groupBy);
    return groupBy
      ? buildDistribution(entities, { groupByField: groupBy })
      : [];
  },
  // Ordered, decreasing stages (widest first) so the trapezoids step down.
  "chart-funnel": (entities, config) => {
    const stageField = str(config.stageField);
    return stageField
      ? buildDistribution(entities, { groupByField: stageField })
      : [];
  },
  "chart-radar": (entities, config) =>
    buildAxes(entities, {
      metrics: Array.isArray(config.metrics)
        ? config.metrics.filter((m): m is string => typeof m === "string")
        : [],
      aggregation: pick(config.aggregation, AGGREGATIONS, "avg"),
    }),
  "chart-composed": (entities, config, now) =>
    buildComposedSeries(entities, {
      timePeriod: pick(config.timePeriod, PERIODS, "week"),
      barAggregation: pick(config.barAggregation, AGGREGATIONS, "count"),
      barField: str(config.barField),
      lineAggregation: pick(config.lineAggregation, AGGREGATIONS, "count"),
      lineField: str(config.lineField),
      now,
    }),
  "chart-gauge": scalar,
  "chart-ring": scalar,
  "chart-scatter": (entities, config) => {
    const xField = str(config.xField);
    const yField = str(config.yField);
    return xField && yField ? buildPoints(entities, { xField, yField }) : [];
  },
  "chart-sankey": (entities, config) => {
    const sourceField = str(config.sourceField);
    const targetField = str(config.targetField);
    return sourceField && targetField
      ? buildFlow(entities, { sourceField, targetField })
      : { nodes: [], links: [] };
  },
  "chart-choropleth": (entities, config) => {
    const regionField = str(config.regionField);
    return regionField
      ? buildRegionValues(entities, {
          regionField,
          aggregation: pick(config.aggregation, REGION_AGGREGATIONS, "count"),
          valueField: str(config.valueField),
        })
      : {};
  },
} satisfies { [K in ChartCellKey]: Shaper<K> };

/** Shape a live query's entities into the data `cellKey` draws. */
export function shapeChartEntities<K extends ChartCellKey>(
  cellKey: K,
  entities: AnyEntity[],
  config: ChartConfig,
  now: Date = new Date()
): ChartDataFor<K> {
  const shaper = CHART_QUERY_SHAPERS[cellKey] as Shaper<K>;
  return shaper(entities, config, now);
}

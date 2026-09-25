/**
 * Chart data — the ONE schema for the data a chart cell draws (decision D2).
 *
 * A chart embed reads its data one of two ways: LIVE (a query over a profile,
 * shaped in the browser) or as a SNAPSHOT (`props.data`, frozen at write time,
 * with `props.capturedAt`). Both land in the same shape, declared per chart by
 * the catalog (`dataBinding.dataShape`), so a frozen chart draws exactly what
 * the live one drew, and a hand/AI-written snapshot is validated against the
 * same rules before it reaches a chart primitive.
 *
 * A malformed snapshot is an ERROR with a message — never coerced to an empty
 * chart. An empty array is a valid, empty snapshot; `{"data": "oops"}` is not.
 *
 * LEAF: no zod, no React. The browser, the backend's write-time diagnostics and
 * relay can all call `parseChartData`.
 */

import type { WidgetTypeKey } from "./types.js";

export const CHART_DATA_SHAPES = [
  "series",
  "categories",
  "composed",
  "scalar",
  "points",
  "flow",
  "regions",
] as const;
export type ChartDataShape = (typeof CHART_DATA_SHAPES)[number];

/** `series` — a line/area over time: x is an ISO date (or a number). */
export interface ChartSeriesPoint {
  x: string | number;
  y: number;
}
/** `categories` — one value per label (bar, pie, funnel stages, radar axes). */
export interface ChartCategoryPoint {
  label: string;
  value: number;
}
/** `composed` — bars + a line per bucket (x is the bucket's label). */
export interface ChartComposedPoint {
  x: string;
  bar: number;
  line: number;
}
/** `points` — scatter: two numbers per point. */
export interface ChartXYPoint {
  x: number;
  y: number;
  label?: string;
}
/** `flow` — sankey: every link names two node ids. */
export interface ChartFlow {
  nodes: Array<{ id: string; label: string }>;
  links: Array<{ source: string; target: string; value: number }>;
}
/** `regions` — choropleth: region code/name → value. */
export type ChartRegions = Record<string, number>;

export interface ChartDataByShape {
  series: ChartSeriesPoint[];
  categories: ChartCategoryPoint[];
  composed: ChartComposedPoint[];
  /** `scalar` — one number (gauge / ring: the raw value, normalized by the cell). */
  scalar: number;
  points: ChartXYPoint[];
  flow: ChartFlow;
  regions: ChartRegions;
}

export type ChartData = ChartDataByShape[ChartDataShape];

/**
 * The shape each chart cell draws — the ONE map. The catalog's
 * `dataBinding.dataShape` is read from it, and the browser's live shapers are
 * typed against it, so a chart's live result and its snapshot cannot disagree.
 * `satisfies` over the declared chart keys: a new `chart-*` key without a
 * shape fails the build.
 */
export const CHART_DATA_SHAPE_BY_KEY = {
  "chart-line": "series",
  "chart-area": "series",
  "chart-live-line": "series",
  "chart-profit-loss": "series",
  "chart-bar": "categories",
  "chart-pie": "categories",
  "chart-funnel": "categories",
  "chart-radar": "categories",
  "chart-composed": "composed",
  "chart-gauge": "scalar",
  "chart-ring": "scalar",
  "chart-scatter": "points",
  "chart-sankey": "flow",
  "chart-choropleth": "regions",
} as const satisfies Record<
  Extract<WidgetTypeKey, `chart-${string}`>,
  ChartDataShape
>;

export type ChartCellKey = keyof typeof CHART_DATA_SHAPE_BY_KEY;
/** The data a given chart draws. */
export type ChartDataFor<K extends ChartCellKey> =
  ChartDataByShape[(typeof CHART_DATA_SHAPE_BY_KEY)[K]];

export function isChartCellKey(key: string): key is ChartCellKey {
  return Object.prototype.hasOwnProperty.call(CHART_DATA_SHAPE_BY_KEY, key);
}

export type ChartDataParse<S extends ChartDataShape = ChartDataShape> =
  { ok: true; data: ChartDataByShape[S] } | { ok: false; message: string };

/**
 * A small valid example per shape — what the AI-facing example directive and
 * the prompts show, and what the tests feed every inline-capable chart.
 */
export const CHART_DATA_EXAMPLES: {
  [S in ChartDataShape]: ChartDataByShape[S];
} = {
  series: [
    { x: "2026-09-01", y: 4 },
    { x: "2026-09-08", y: 7 },
    { x: "2026-09-15", y: 5 },
  ],
  categories: [
    { label: "Done", value: 12 },
    { label: "In progress", value: 5 },
    { label: "Blocked", value: 2 },
  ],
  composed: [
    { x: "Sep 1", bar: 4, line: 120 },
    { x: "Sep 8", bar: 7, line: 180 },
  ],
  scalar: 72,
  points: [
    { x: 3, y: 1200, label: "Acme" },
    { x: 8, y: 5400, label: "Globex" },
  ],
  flow: {
    nodes: [
      { id: "src:web", label: "web" },
      { id: "tgt:won", label: "won" },
    ],
    links: [{ source: "src:web", target: "tgt:won", value: 9 }],
  },
  regions: { FR: 12, US: 30 },
};

/** One-line description of each shape, for prompts and the AI-facing schema. */
export const CHART_DATA_SHAPE_HINTS: Record<ChartDataShape, string> = {
  series: 'array of {"x": ISO date or number, "y": number}',
  categories: 'array of {"label": string, "value": number}',
  composed: 'array of {"x": string, "bar": number, "line": number}',
  scalar: "a single number",
  points: 'array of {"x": number, "y": number, "label"?: string}',
  flow: '{"nodes": [{"id", "label"}], "links": [{"source": node id, "target": node id, "value": number}]}',
  regions: 'object of region code or country name → number, e.g. {"FR": 12}',
};

// ─── Validation ──────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isDateString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "" && !Number.isNaN(Date.parse(v));

type Check = (item: unknown, index: number) => string | null;

function arrayOf<T>(
  value: unknown,
  what: string,
  check: Check
): { ok: true; data: T[] } | { ok: false; message: string } {
  if (!Array.isArray(value))
    return { ok: false, message: `data must be an array of ${what}` };
  for (let i = 0; i < value.length; i++) {
    const problem = check(value[i], i);
    if (problem) return { ok: false, message: `data[${i}] ${problem}` };
  }
  return { ok: true, data: value as T[] };
}

const PARSERS: {
  [S in ChartDataShape]: (value: unknown) => ChartDataParse<S>;
} = {
  series: (value) =>
    arrayOf<ChartSeriesPoint>(value, "{x, y} points", (p) => {
      if (!isRecord(p)) return "must be an object {x, y}";
      if (!(isFiniteNumber(p.x) || isDateString(p.x))) {
        return "x must be an ISO date or a number (for named categories use a bar chart)";
      }
      return isFiniteNumber(p.y) ? null : "y must be a number";
    }),
  categories: (value) =>
    arrayOf<ChartCategoryPoint>(value, "{label, value} items", (p) => {
      if (!isRecord(p)) return "must be an object {label, value}";
      if (typeof p.label !== "string") return "label must be a string";
      return isFiniteNumber(p.value) ? null : "value must be a number";
    }),
  composed: (value) =>
    arrayOf<ChartComposedPoint>(value, "{x, bar, line} buckets", (p) => {
      if (!isRecord(p)) return "must be an object {x, bar, line}";
      if (typeof p.x !== "string") return "x must be a string";
      if (!isFiniteNumber(p.bar)) return "bar must be a number";
      return isFiniteNumber(p.line) ? null : "line must be a number";
    }),
  scalar: (value) =>
    isFiniteNumber(value)
      ? { ok: true, data: value }
      : { ok: false, message: "data must be a single number" },
  points: (value) =>
    arrayOf<ChartXYPoint>(value, "{x, y} points", (p) => {
      if (!isRecord(p)) return "must be an object {x, y}";
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y))
        return "x and y must be numbers";
      return p.label === undefined || typeof p.label === "string"
        ? null
        : "label must be a string";
    }),
  flow: (value) => {
    if (
      !isRecord(value) ||
      !Array.isArray(value.nodes) ||
      !Array.isArray(value.links)
    ) {
      return { ok: false, message: "data must be an object {nodes, links}" };
    }
    const ids = new Set<string>();
    for (let i = 0; i < value.nodes.length; i++) {
      const n = value.nodes[i];
      if (
        !isRecord(n) ||
        typeof n.id !== "string" ||
        typeof n.label !== "string"
      ) {
        return {
          ok: false,
          message: `data.nodes[${i}] must be {id: string, label: string}`,
        };
      }
      ids.add(n.id);
    }
    for (let i = 0; i < value.links.length; i++) {
      const l = value.links[i];
      if (
        !isRecord(l) ||
        typeof l.source !== "string" ||
        typeof l.target !== "string"
      ) {
        return {
          ok: false,
          message: `data.links[${i}] must be {source, target, value}`,
        };
      }
      if (!ids.has(l.source) || !ids.has(l.target)) {
        return {
          ok: false,
          message: `data.links[${i}] names a node id that is not in data.nodes`,
        };
      }
      if (!isFiniteNumber(l.value))
        return {
          ok: false,
          message: `data.links[${i}].value must be a number`,
        };
    }
    return { ok: true, data: value as unknown as ChartFlow };
  },
  regions: (value) => {
    if (!isRecord(value))
      return {
        ok: false,
        message: "data must be an object of region → number",
      };
    for (const [region, v] of Object.entries(value)) {
      if (!isFiniteNumber(v))
        return { ok: false, message: `data["${region}"] must be a number` };
    }
    return { ok: true, data: value as ChartRegions };
  },
};

/** Validate a chart's data against its shape. Never coerces. */
export function parseChartData<S extends ChartDataShape>(
  shape: S,
  value: unknown
): ChartDataParse<S> {
  return PARSERS[shape](value) as ChartDataParse<S>;
}

export type ChartSnapshotParse<S extends ChartDataShape = ChartDataShape> =
  | { ok: true; data: ChartDataByShape[S]; capturedAt?: string }
  | { ok: false; message: string };

/**
 * Read a snapshot embed's props: `data` against the shape, and `capturedAt`
 * (optional, but when present it must be a date — it becomes the
 * "Snapshot · <date>" badge).
 */
export function parseChartSnapshot<S extends ChartDataShape>(
  shape: S,
  props: Record<string, unknown>
): ChartSnapshotParse<S> {
  const parsed = parseChartData(shape, props.data);
  if (!parsed.ok) return parsed;
  const capturedAt = props.capturedAt;
  if (capturedAt === undefined) return { ok: true, data: parsed.data };
  if (!isDateString(capturedAt)) {
    return {
      ok: false,
      message: "capturedAt must be an ISO date (when the numbers were taken)",
    };
  }
  return { ok: true, data: parsed.data, capturedAt };
}

/** Does this embed carry a snapshot? (`data` present, even if malformed.) */
export function hasChartSnapshot(
  props: Record<string, unknown> | null | undefined
): boolean {
  return !!props && Object.prototype.hasOwnProperty.call(props, "data");
}

/**
 * "Freeze": the embed's props with the current live result stored inline. The
 * query keys (profileSlug, aggregation, …) are KEPT, so "make live" can read
 * live again by dropping `data` + `capturedAt`.
 */
export function freezeChartProps(
  props: Record<string, unknown>,
  data: ChartData,
  capturedAt: Date
): Record<string, unknown> {
  return { ...props, data, capturedAt: capturedAt.toISOString() };
}

/** "Make live": the same embed without its snapshot. */
export function chartPropsMadeLive(
  props: Record<string, unknown>
): Record<string, unknown> {
  const { data: _data, capturedAt: _capturedAt, ...rest } = props;
  return rest;
}

/** The AI-facing JSON Schema of `props.data` for a shape. */
export function chartDataJsonSchema(
  shape: ChartDataShape
): Record<string, unknown> {
  const num = { type: "number" };
  const str = { type: "string" };
  const obj = (properties: Record<string, unknown>, required: string[]) => ({
    type: "object",
    properties,
    required,
  });
  const description = `Snapshot data: ${CHART_DATA_SHAPE_HINTS[shape]}.`;
  switch (shape) {
    case "series":
      return {
        type: "array",
        description,
        items: obj({ x: { type: ["string", "number"] }, y: num }, ["x", "y"]),
      };
    case "categories":
      return {
        type: "array",
        description,
        items: obj({ label: str, value: num }, ["label", "value"]),
      };
    case "composed":
      return {
        type: "array",
        description,
        items: obj({ x: str, bar: num, line: num }, ["x", "bar", "line"]),
      };
    case "scalar":
      return { type: "number", description };
    case "points":
      return {
        type: "array",
        description,
        items: obj({ x: num, y: num, label: str }, ["x", "y"]),
      };
    case "flow":
      return {
        ...obj(
          {
            nodes: {
              type: "array",
              items: obj({ id: str, label: str }, ["id", "label"]),
            },
            links: {
              type: "array",
              items: obj({ source: str, target: str, value: num }, [
                "source",
                "target",
                "value",
              ]),
            },
          },
          ["nodes", "links"]
        ),
        description,
      };
    case "regions":
      return { type: "object", description, additionalProperties: num };
  }
}

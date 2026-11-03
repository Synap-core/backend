/**
 * Chart geometry — the MARKS a chart snapshot draws, for every surface.
 *
 * `describeEmbed` decides WHAT an embed is (`chart-snapshot`, with numbers that
 * parsed for their shape); this decides WHERE each mark goes. The web console
 * draws it as inline SVG, relay as react-native-svg — neither keeps its own
 * scale, path or ring arithmetic, so a bar is the same length on both.
 *
 *   categories  (bar, funnel, radar) bars on ONE scale that always holds
 *               zero, in a 100 × 10 track per row; each label sits in its OWN
 *               column on its OWN row (`labelColumnPercent`), so a long label
 *               wraps and never overlaps a bar or another label, at any width
 *   series      a line (an area for `chart-area`) in a `width × height` box,
 *               one dot per point; x on time (or the number) when every point
 *               has one, else evenly spaced; y ticks = top and bottom of the
 *               scale; x ticks = the first and last point, at opposite edges
 *   pie         (`chart-pie`) segments of a ring whose circumference is 100,
 *               so each segment's dash IS its share; one legend row per
 *               category, in order. A negative value takes no share; a pie
 *               whose values add up to zero draws no segment (never NaN)
 *   composed    bars and a line over ONE x axis, in a `width × height` box:
 *               one slot per bucket, its bar centred in it and the line's dot
 *               above the same centre; the bars and the line each have their
 *               OWN scale, and each holds zero; y ticks = top and bottom of
 *               each scale (bars at the start edge, line at the end edge);
 *               x ticks = the first and last bucket
 *   scalar      a ring whose circumference is 100, so the dash IS the percent
 *   other       a table (points, flow, regions): columns + cells
 *   empty       a snapshot with no values (never an empty drawing)
 *
 * Numbers are formatted here (`formatChartNumber`); WORDS are not — the spoken
 * sentence, the table headings and "(no label)" come from the vocabulary door
 * (`resolveChartSpokenLabel`, `resolveChartTableHead` in
 * `@synap-core/types/vocabulary`). `values` is the plain data that sentence is
 * built from. The composed chart's series names are the AUTHORED ones
 * (`barLabel` / `lineLabel`) or null; the fallback word is the vocabulary's.
 *
 * Pure data → data: no React, no DOM, no measuring. LEAF: imports only this
 * folder.
 */

import type {
  ChartCategoryPoint,
  ChartComposedPoint,
  ChartDataShape,
  ChartSeriesPoint,
} from "./chart-data.js";
import type { ChartSnapshotModel } from "./embed-model.js";

/** The default series box — the web console's viewBox. */
export const CHART_LINE_WIDTH = 300;
export const CHART_LINE_HEIGHT = 120;
/** Inset of the series plot inside its box, so a dot on the edge stays whole. */
export const CHART_LINE_PAD = 6;
/** Bars: the share of the row (percent) the label column may take, at most. */
export const CHART_LABEL_COLUMN_PERCENT = 40;
/** One bar track: a 100-wide (percent) by 10-high box per row. */
export const CHART_BAR_TRACK = { width: 100, height: 10 } as const;
/** Composed: the share of a bucket's slot its bar takes (the rest is the gap). */
export const CHART_COMPOSED_BAR_SHARE = 0.6;
/** A ring of radius 100 / 2π has circumference 100: the dash is the percent. */
export const CHART_RING = {
  size: 36,
  cx: 18,
  cy: 18,
  r: 15.9155,
  strokeWidth: 3.5,
} as const;

export interface ChartScale {
  /** Bottom of the scale — never above zero. */
  lo: number;
  /** Top of the scale — never below zero. */
  hi: number;
  /** `hi - lo`, or 1 when every value is zero (so nothing divides by zero). */
  span: number;
}

/** One named value, as a reader would say it. `name: null` = no label. */
export interface ChartSpokenValue {
  name: string | null;
  value: string;
}

export interface ChartBar {
  /** The authored label ("" when the author gave none). */
  label: string;
  /** What the label column prints: the label, or "—" when there is none. */
  labelText: string;
  value: number;
  valueText: string;
  /** In track units (0–100): left edge and length. Always inside the track. */
  x: number;
  w: number;
  y: number;
  h: number;
  negative: boolean;
}

export interface ChartLinePoint {
  /** Box coordinates of the dot. */
  cx: number;
  cy: number;
  x: string | number;
  y: number;
}

export interface ChartComposedBar {
  /** The bucket's label as authored, and what an axis prints ("—" when blank). */
  label: string;
  labelText: string;
  value: number;
  valueText: string;
  /** Box coordinates of the bar: left, top, width, height. */
  x: number;
  y: number;
  w: number;
  h: number;
  negative: boolean;
}

export interface ChartComposedLinePoint {
  /** Box coordinates of the dot (above the centre of its bucket's bar). */
  cx: number;
  cy: number;
  value: number;
  valueText: string;
}

/** One bucket as a reader would say it. `name: null` = no label. */
export interface ChartComposedSpokenValue {
  name: string | null;
  bar: string;
  line: string;
}

export interface ChartPieSegment {
  /** The authored label ("" when none), and what the legend prints ("—"). */
  label: string;
  labelText: string;
  value: number;
  valueText: string;
  /** Share of the whole, 0–100 (0 for a negative value or a zero total). */
  share: number;
  /** The share as a legend prints it ("42%"). */
  shareText: string;
  /** Where the segment starts along the ring, 0–100. */
  offset: number;
  /** `strokeDasharray` over a circumference of 100: the segment, then the rest. */
  dash: string;
  /** `strokeDashoffset` that starts the dash at `offset`. */
  dashOffset: number;
}

export interface ChartTick {
  text: string;
  /** Which edge of the plot the label sits against. */
  align: "start" | "end";
}

export interface ChartTableCell {
  text: string;
  /** A number (set in tabular figures), as opposed to a name. */
  numeric: boolean;
}

export type ChartGeometry =
  | { kind: "empty"; shape: ChartDataShape }
  | {
      kind: "bars";
      scale: ChartScale;
      /** Max share (percent) of the row width for the label column — own column, own row. */
      labelColumnPercent: number;
      track: typeof CHART_BAR_TRACK;
      bars: ChartBar[];
      values: ChartSpokenValue[];
    }
  | {
      kind: "line";
      area: boolean;
      width: number;
      height: number;
      pad: number;
      scale: ChartScale;
      /** y of the zero line in box coordinates. */
      baseline: number;
      /** The line, `M x,y L x,y …` (2 decimals). */
      path: string;
      /** The filled area under the line (closed to the baseline), or null. */
      areaPath: string | null;
      points: ChartLinePoint[];
      /** The top and bottom of the scale, formatted. */
      yTicks: { top: string; bottom: string };
      /** The first point (start edge) and, when there are two or more, the last (end edge). */
      xTicks: ChartTick[];
      values: ChartSpokenValue[];
    }
  | {
      kind: "ring";
      ring: typeof CHART_RING;
      value: number;
      valueText: string;
      /** 0–100. */
      percent: number;
      percentRounded: number;
      /** `strokeDasharray` for the arc over a circumference of 100. */
      dash: string;
      /** Show the percent beside the number only when they differ. */
      showPercent: boolean;
    }
  | {
      kind: "pie";
      ring: typeof CHART_RING;
      total: number;
      totalText: string;
      /** One per category, in the authored order; the legend lists them all. */
      segments: ChartPieSegment[];
      values: ChartSpokenValue[];
    }
  | {
      kind: "composed";
      width: number;
      height: number;
      pad: number;
      barScale: ChartScale;
      lineScale: ChartScale;
      /** y of the bars' zero line in box coordinates. */
      baseline: number;
      bars: ChartComposedBar[];
      /** The line, `M x,y L x,y …` (2 decimals). */
      path: string;
      points: ChartComposedLinePoint[];
      /** Top and bottom of the bars' scale (start edge) and the line's (end edge). */
      barTicks: { top: string; bottom: string };
      lineTicks: { top: string; bottom: string };
      /** The first bucket (start edge) and, when there are two or more, the last (end edge). */
      xTicks: ChartTick[];
      /** The authored series names, or null (the vocabulary names them then). */
      barLabel: string | null;
      lineLabel: string | null;
      values: ChartComposedSpokenValue[];
    }
  | {
      kind: "table";
      shape: "points" | "flow" | "regions";
      rows: ChartTableCell[][];
    };

export interface ChartGeometryOptions {
  /** Width of the series box (default `CHART_LINE_WIDTH`, the web viewBox). */
  width?: number;
  /** Height of the series box (default `CHART_LINE_HEIGHT`). */
  height?: number;
  /** How an ISO date on the x axis reads. Default: `formatChartDate`. */
  formatDate?: (iso: string) => string;
}

/** A number as a chart prints it (the reader's locale grouping). */
export function formatChartNumber(value: number): string {
  return value.toLocaleString();
}

/** An ISO date as a chart axis prints it ("22 Oct 2026"); "—" when unreadable. */
export function formatChartDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** A scale that always holds zero, so every bar starts from one baseline. */
export function chartScale(values: number[]): ChartScale {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  return { lo, hi, span: hi - lo || 1 };
}

function cell(value: string | number): ChartTableCell {
  return typeof value === "number"
    ? { text: formatChartNumber(value), numeric: true }
    : { text: value, numeric: false };
}

function isEmpty(model: ChartSnapshotModel): boolean {
  switch (model.shape) {
    case "scalar":
      return false;
    case "flow":
      return model.data.links.length === 0;
    case "regions":
      return Object.keys(model.data).length === 0;
    default:
      return model.data.length === 0;
  }
}

function bars(data: ChartCategoryPoint[]): ChartGeometry {
  const scale = chartScale(data.map((d) => d.value));
  const at = (v: number) => ((v - scale.lo) / scale.span) * 100;
  return {
    kind: "bars",
    scale,
    labelColumnPercent: CHART_LABEL_COLUMN_PERCENT,
    track: CHART_BAR_TRACK,
    bars: data.map((d) => {
      const x = at(Math.min(0, d.value));
      return {
        label: d.label,
        labelText: d.label || "—",
        value: d.value,
        valueText: formatChartNumber(d.value),
        x,
        w: Math.max(at(Math.max(0, d.value)) - x, 0),
        y: 0,
        h: CHART_BAR_TRACK.height,
        negative: d.value < 0,
      };
    }),
    values: data.map((d) => ({
      name: d.label || null,
      value: formatChartNumber(d.value),
    })),
  };
}

function line(
  data: ChartSeriesPoint[],
  area: boolean,
  opts: ChartGeometryOptions
): ChartGeometry {
  const { width, height } = boxSize(opts);
  const pad = CHART_LINE_PAD;
  const formatDate = opts.formatDate ?? formatChartDate;
  const xText = (x: string | number) =>
    typeof x === "number" ? formatChartNumber(x) : formatDate(x);

  const raw = data.map((p) =>
    typeof p.x === "number" ? p.x : Date.parse(p.x)
  );
  const xs = raw.every(Number.isFinite) ? raw : data.map((_, i) => i);
  const xLo = Math.min(...xs);
  const xSpan = Math.max(...xs) - xLo;
  const scale = chartScale(data.map((p) => p.y));
  const yAt = (y: number) =>
    height - pad - ((y - scale.lo) / scale.span) * (height - 2 * pad);
  const points: ChartLinePoint[] = data.map((p, i) => ({
    cx: xSpan ? pad + ((xs[i]! - xLo) / xSpan) * (width - 2 * pad) : width / 2,
    cy: yAt(p.y),
    x: p.x,
    y: p.y,
  }));
  const path = points
    .map(
      (p, i) => `${i === 0 ? "M" : "L"}${p.cx.toFixed(2)},${p.cy.toFixed(2)}`
    )
    .join(" ");
  const baseline = yAt(0);
  const first = points[0];
  const last = points[points.length - 1];
  const xTicks: ChartTick[] = [];
  if (first) xTicks.push({ text: xText(first.x), align: "start" });
  if (last && points.length > 1)
    xTicks.push({ text: xText(last.x), align: "end" });
  return {
    kind: "line",
    area,
    width,
    height,
    pad,
    scale,
    baseline,
    path,
    areaPath:
      area && first && last
        ? `${path} L${last.cx.toFixed(2)},${baseline.toFixed(2)} L${first.cx.toFixed(2)},${baseline.toFixed(2)} Z`
        : null,
    points,
    yTicks: {
      top: formatChartNumber(scale.lo + scale.span),
      bottom: formatChartNumber(scale.lo),
    },
    xTicks,
    values: data.map((p) => ({
      name: xText(p.x),
      value: formatChartNumber(p.y),
    })),
  };
}

function boxSize(opts: ChartGeometryOptions): {
  width: number;
  height: number;
} {
  return {
    width: opts.width && opts.width > 0 ? opts.width : CHART_LINE_WIDTH,
    height: opts.height && opts.height > 0 ? opts.height : CHART_LINE_HEIGHT,
  };
}

function pie(data: ChartCategoryPoint[]): ChartGeometry {
  // A pie shows parts of a whole: a negative value has no part to draw.
  const parts = data.map((d) => Math.max(0, d.value));
  const total = parts.reduce((sum, v) => sum + v, 0);
  let offset = 0;
  const segments: ChartPieSegment[] = data.map((d, i) => {
    const share = total > 0 ? (parts[i]! / total) * 100 : 0;
    const start = offset;
    offset += share;
    return {
      label: d.label,
      labelText: d.label || "—",
      value: d.value,
      valueText: formatChartNumber(d.value),
      share,
      shareText: `${Math.round(share)}%`,
      offset: start,
      dash: `${share} ${100 - share}`,
      dashOffset: start > 0 ? 100 - start : 0,
    };
  });
  return {
    kind: "pie",
    ring: CHART_RING,
    total,
    totalText: formatChartNumber(total),
    segments,
    values: segments.map((s) => ({
      name: s.label || null,
      value: `${s.valueText} (${s.shareText})`,
    })),
  };
}

function composed(
  data: ChartComposedPoint[],
  names: { barLabel: string | null; lineLabel: string | null },
  opts: ChartGeometryOptions
): ChartGeometry {
  const { width, height } = boxSize(opts);
  const pad = CHART_LINE_PAD;
  const barScale = chartScale(data.map((d) => d.bar));
  const lineScale = chartScale(data.map((d) => d.line));
  const yAt = (scale: ChartScale, v: number) =>
    height - pad - ((v - scale.lo) / scale.span) * (height - 2 * pad);
  const slot = (width - 2 * pad) / data.length;
  const barW = slot * CHART_COMPOSED_BAR_SHARE;
  const centre = (i: number) => pad + slot * (i + 0.5);
  const baseline = yAt(barScale, 0);
  const bars: ChartComposedBar[] = data.map((d, i) => {
    const top = yAt(barScale, d.bar);
    return {
      label: d.x,
      labelText: d.x || "—",
      value: d.bar,
      valueText: formatChartNumber(d.bar),
      x: centre(i) - barW / 2,
      y: Math.min(top, baseline),
      w: barW,
      h: Math.abs(baseline - top),
      negative: d.bar < 0,
    };
  });
  const points: ChartComposedLinePoint[] = data.map((d, i) => ({
    cx: centre(i),
    cy: yAt(lineScale, d.line),
    value: d.line,
    valueText: formatChartNumber(d.line),
  }));
  const path = points
    .map(
      (p, i) => `${i === 0 ? "M" : "L"}${p.cx.toFixed(2)},${p.cy.toFixed(2)}`
    )
    .join(" ");
  const ticks = (scale: ChartScale) => ({
    top: formatChartNumber(scale.lo + scale.span),
    bottom: formatChartNumber(scale.lo),
  });
  const xTicks: ChartTick[] = [{ text: bars[0]!.labelText, align: "start" }];
  if (bars.length > 1)
    xTicks.push({ text: bars[bars.length - 1]!.labelText, align: "end" });
  return {
    kind: "composed",
    width,
    height,
    pad,
    barScale,
    lineScale,
    baseline,
    bars,
    path,
    points,
    barTicks: ticks(barScale),
    lineTicks: ticks(lineScale),
    xTicks,
    barLabel: names.barLabel,
    lineLabel: names.lineLabel,
    values: data.map((d, i) => ({
      name: d.x || null,
      bar: bars[i]!.valueText,
      line: points[i]!.valueText,
    })),
  };
}

/** The marks for one chart snapshot. */
export function chartGeometry(
  model: ChartSnapshotModel,
  opts: ChartGeometryOptions = {}
): ChartGeometry {
  if (isEmpty(model)) return { kind: "empty", shape: model.shape };
  switch (model.shape) {
    case "categories":
      return model.cellKey === "chart-pie" ? pie(model.data) : bars(model.data);
    case "series":
      return line(model.data, model.cellKey === "chart-area", opts);
    case "scalar": {
      const percentRounded = Math.round(model.percent);
      return {
        kind: "ring",
        ring: CHART_RING,
        value: model.data,
        valueText: formatChartNumber(model.data),
        percent: model.percent,
        percentRounded,
        dash: `${model.percent} 100`,
        showPercent: percentRounded !== model.data,
      };
    }
    case "composed":
      return composed(model.data, model, opts);
    case "points":
      return {
        kind: "table",
        shape: "points",
        rows: model.data.map((d) => [
          cell(d.label ?? "—"),
          cell(d.x),
          cell(d.y),
        ]),
      };
    case "flow": {
      const name = new Map(model.data.nodes.map((n) => [n.id, n.label]));
      return {
        kind: "table",
        shape: "flow",
        rows: model.data.links.map((l) => [
          cell(name.get(l.source) ?? l.source),
          cell(name.get(l.target) ?? l.target),
          cell(l.value),
        ]),
      };
    }
    case "regions":
      return {
        kind: "table",
        shape: "regions",
        rows: Object.entries(model.data).map(([k, v]) => [cell(k), cell(v)]),
      };
  }
}

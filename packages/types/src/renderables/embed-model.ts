/**
 * Embed model — WHAT a `:::synap-*` reference embed IS, for a surface that
 * draws it (the pod's web console first; relay and the desktop next).
 *
 * One decision, many drawings: each surface asks `describeEmbed` and draws the
 * answer its own way, so "a frozen chart", "a live chart", "a sandboxed cell"
 * and "a record" mean the same thing on every screen. The meanings match
 * relay's `describeMarkdownEmbed` (entities open, views are a door, cells are
 * never mounted outside the desktop, unknown kinds humanize), plus the chart
 * snapshot, which a reader can draw from the numbers alone:
 *
 *   chart-snapshot  a built-in chart carrying `data` that parses for its shape
 *   chart-broken    a chart whose snapshot (or props) cannot be read — the
 *                   parser's message, NEVER an empty chart (an EMPTY result and
 *                   a FAILED read are different facts)
 *   chart-live      a chart with no `data`: it needs a live query
 *   entity          a record reference (identity is fetched by the surface)
 *   view            a saved view
 *   cell-frame      an installed or generated cell (`cell:…`, `generated:…`)
 *                   or a cell instance: sandboxed HTML, drawn ONLY by the
 *                   desktop's cell frame
 *   cell-builtin    any other catalog widget, named by the catalog
 *   broken          the directive names nothing (no id / key) — malformed
 *   unknown         a `synap-*` kind or cell key this catalog does not know
 *
 * FACTS, not words: `label` is what the author or the catalog named it, or
 * null. The words a reader sees (the noun, a humanized key) come from the
 * vocabulary door, `resolveEmbedWords` (`@synap-core/types/vocabulary`) —
 * this subpath stays a leaf that imports only its own files.
 *
 * Pure data → data: no React, no DOM, no markdown parser (the caller reads the
 * directive with markdown-core's `readEmbed` and passes its parts).
 */

import {
  CHART_DATA_SHAPE_BY_KEY,
  hasChartSnapshot,
  isChartCellKey,
  parseChartSnapshot,
  type ChartCellKey,
  type ChartDataByShape,
  type ChartDataShape,
} from "./chart-data.js";
import { dataBindingFor, isInstalledRenderableKey } from "./catalog.js";
import { WIDGET_BY_KEY } from "./widgets.js";

export interface DescribeEmbedInput {
  /** The directive name without `synap-`: `entity` | `view` | `cell` | … */
  kind: string;
  /** Reference attributes as authored (markdown-core `Embed.ref`). */
  attrs: Readonly<Record<string, string | null | undefined>>;
  /** Decoded props (markdown-core `Embed.props`), when they could be read. */
  props?: Record<string, unknown> | null;
  /** Why the props could not be read (markdown-core `Embed.propsError`). */
  propsError?: string | null;
}

/** A built-in chart whose snapshot parsed: what `chartGeometry` draws from. */
export type ChartSnapshotModel = {
  [S in ChartDataShape]: {
    kind: "chart-snapshot";
    cellKey: ChartCellKey;
    shape: S;
    data: ChartDataByShape[S];
    /** ISO date the numbers were taken, when the author recorded it. */
    capturedAt: string | null;
    /** The authored label, else the catalog name. */
    label: string | null;
  } & (S extends "scalar"
    ? {
        /** The scalar on 0–100, as a gauge / ring draws it. */
        percent: number;
      }
    : unknown);
}[ChartDataShape];

export type EmbedModel =
  | ChartSnapshotModel
  | {
      kind: "chart-broken";
      cellKey: ChartCellKey;
      label: string | null;
      /** What is wrong with the snapshot, in the parser's words. */
      message: string;
    }
  | { kind: "chart-live"; cellKey: ChartCellKey; label: string | null }
  /** `label` is the AUTHORED label only — never a fetched title. */
  | { kind: "entity"; id: string; label: string | null }
  | {
      kind: "view";
      viewId: string;
      viewType: string | null;
      label: string | null;
    }
  | {
      kind: "cell-frame";
      cellKey: string | null;
      /** The key's own name, without its namespace (`cell:pkg:deal-board` → `deal-board`). */
      keyName: string | null;
      instanceId: string | null;
      label: string | null;
    }
  /** `label` is the authored label, else the catalog's name — never null. */
  | { kind: "cell-builtin"; cellKey: string; label: string }
  | { kind: "broken"; directiveKind: string }
  | {
      kind: "unknown";
      directiveKind: string;
      /** For an unknown CELL: the key the catalog does not know. */
      cellKey: string | null;
      label: string | null;
    };

/**
 * A snapshot on a chart whose catalog binding cannot hold one (`chart-live-line`
 * polls). The desktop says the same in `useChartSeries`.
 */
export const LIVE_ONLY_SNAPSHOT_MESSAGE =
  "This chart reads live data only — it can’t hold a snapshot. Remove its data to read live.";

/**
 * A gauge / ring scalar on 0–100: `completion` (the default aggregation) is
 * already a percentage; count / sum / avg map onto `max` (default 100).
 */
export function chartScalarPercent(
  props: Record<string, unknown> | null | undefined,
  value: number
): number {
  const aggregation = props?.aggregation ?? "completion";
  const max = Number(props?.max);
  const ceiling =
    aggregation !== "completion" && Number.isFinite(max) && max > 0 ? max : 100;
  return Math.max(0, Math.min(100, (value / ceiling) * 100));
}

function attr(input: DescribeEmbedInput, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input.attrs[key]?.trim();
    if (value) return value;
  }
  return null;
}

function authoredLabel(input: DescribeEmbedInput): string | null {
  const fromAttr = attr(input, "label");
  if (fromAttr) return fromAttr;
  const fromProps = input.props?.label;
  return typeof fromProps === "string" && fromProps.trim()
    ? fromProps.trim()
    : null;
}

function describeCell(input: DescribeEmbedInput): EmbedModel {
  const cellKey = attr(input, "cellKey", "data-cell-key");
  const instanceId = attr(input, "instanceId", "data-instance-id");
  if (!cellKey && !instanceId) return { kind: "broken", directiveKind: "cell" };
  const authored = authoredLabel(input);

  // A sandboxed cell (or an instance whose key only the pod knows) is never
  // drawn outside the desktop's cell frame — even when it carries `data`.
  if (!cellKey || isInstalledRenderableKey(cellKey)) {
    return {
      kind: "cell-frame",
      cellKey,
      keyName: cellKey
        ? (cellKey.split(":").filter(Boolean).pop() ?? null)
        : null,
      instanceId,
      label: authored,
    };
  }

  const def = WIDGET_BY_KEY[cellKey];
  if (isChartCellKey(cellKey)) {
    const label = authored ?? def?.name ?? null;
    if (input.propsError) {
      return {
        kind: "chart-broken",
        cellKey,
        label,
        message: input.propsError,
      };
    }
    const props = input.props ?? {};
    if (!hasChartSnapshot(props)) return { kind: "chart-live", cellKey, label };
    // The catalog decides whether this chart can hold a snapshot at all.
    const binding = def ? dataBindingFor(def) : null;
    if (!binding?.supports.includes("inline")) {
      return {
        kind: "chart-broken",
        cellKey,
        label,
        message: LIVE_ONLY_SNAPSHOT_MESSAGE,
      };
    }
    const shape = CHART_DATA_SHAPE_BY_KEY[cellKey];
    const parsed = parseChartSnapshot(shape, props);
    if (!parsed.ok) {
      return { kind: "chart-broken", cellKey, label, message: parsed.message };
    }
    return {
      kind: "chart-snapshot",
      cellKey,
      shape,
      data: parsed.data,
      capturedAt: parsed.capturedAt ?? null,
      label,
      ...(shape === "scalar"
        ? { percent: chartScalarPercent(props, parsed.data as number) }
        : {}),
    } as ChartSnapshotModel;
  }

  if (def)
    return { kind: "cell-builtin", cellKey, label: authored ?? def.name };
  return { kind: "unknown", directiveKind: "cell", cellKey, label: authored };
}

/** What one reference embed is, for a surface to draw. */
export function describeEmbed(input: DescribeEmbedInput): EmbedModel {
  switch (input.kind) {
    case "entity": {
      const id = attr(input, "id");
      if (!id) return { kind: "broken", directiveKind: "entity" };
      return { kind: "entity", id, label: attr(input, "label") };
    }
    case "view": {
      const viewId = attr(input, "viewId", "data-view-id");
      if (!viewId) return { kind: "broken", directiveKind: "view" };
      return {
        kind: "view",
        viewId,
        viewType: attr(input, "viewType"),
        label: authoredLabel(input),
      };
    }
    case "cell":
      return describeCell(input);
    default:
      return {
        kind: "unknown",
        directiveKind: input.kind,
        cellKey: null,
        label: authoredLabel(input),
      };
  }
}

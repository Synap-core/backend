/**
 * A SITE CHART'S STORED PAYLOAD — what a chart member row holds and how it is
 * read back, with no database and no gate. Split out of `site-charts.ts` (the
 * owner write doors) so the readers can decode a chart without importing those
 * doors: the public read (`public-site-charts.ts`) and the owner's site status
 * (`site-service.ts`, which `site-charts.ts` itself imports, so reading charts
 * there through `site-charts.ts` would be an import cycle). `site-charts.ts`
 * re-exports every name here, so its importers are unchanged.
 */

import {
  WIDGET_BY_KEY,
  dataBindingFor,
  isChartCellKey,
} from "@synap-core/types/renderables";

/** The member collection every chart row carries (0397 CHECK). */
export const CHART_COLLECTION = "@charts";
/** A cellKey: the catalog's and custom cells' shape. */
export const CELL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export const CHART_MODES = ["snapshot", "live"] as const;
export type ChartMode = (typeof CHART_MODES)[number];

/**
 * What a chart member row stores in `published_properties`. `data` +
 * `capturedAt` only for a snapshot; a live chart's are read at serve time.
 */
export interface ChartPayload {
  v: 1;
  mode: ChartMode;
  cellKey: string;
  title?: string;
  props: Record<string, unknown>;
  data?: unknown;
  capturedAt?: string;
}

/** Can the pod re-run this cellKey's query (live mode, or a freeze at publish)? */
export function chartHasQuery(cellKey: string): boolean {
  if (!isChartCellKey(cellKey)) return false;
  const def = WIDGET_BY_KEY[cellKey];
  return !!def && !!dataBindingFor(def)?.supports.includes("query");
}

/** An ISO-parseable date string (a snapshot's `capturedAt`). */
export const isDate = (v: unknown): v is string =>
  typeof v === "string" && !Number.isNaN(Date.parse(v));

/**
 * Decode a stored payload, fail-closed: anything unreadable is `null` (the
 * public read then answers the uniform 404, never a half chart).
 */
export function readChartPayload(raw: unknown): ChartPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (p.mode !== "snapshot" && p.mode !== "live") return null;
  if (typeof p.cellKey !== "string" || !CELL_KEY_RE.test(p.cellKey))
    return null;
  if (!p.props || typeof p.props !== "object" || Array.isArray(p.props))
    return null;
  if (p.title !== undefined && typeof p.title !== "string") return null;
  if (p.mode === "snapshot") {
    if (!("data" in p) || !isDate(p.capturedAt)) return null;
  } else if (!chartHasQuery(p.cellKey)) {
    return null;
  }
  return {
    v: 1,
    mode: p.mode,
    cellKey: p.cellKey,
    ...(typeof p.title === "string" ? { title: p.title } : {}),
    props: p.props as Record<string, unknown>,
    ...(p.mode === "snapshot"
      ? { data: p.data, capturedAt: p.capturedAt as string }
      : {}),
  };
}

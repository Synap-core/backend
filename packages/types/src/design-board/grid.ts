/**
 * THE layout grid of a design page, as data (plan 0fc746f4 §2.4, decision
 * 0fe103c9: flow only). A page is a column grid: 12 columns at an expanded
 * width, 8 at medium, 4 at compact, the width classes of the page grammar
 * (600 / 1024, measured on the page's container).
 *
 * A block placed in a grid (a Section, or a Grid inside one) may say, per
 * width class, how many columns it spans, which column it starts at and
 * whether it is hidden: the only per-width overrides a block has (D5, and the
 * founder's start column of 20 Nov 2026). All three are props of the block:
 *
 *   span   { compact?: 1-4, medium?: 1-8, expanded?: 1-12 }   absent = full width
 *   start  { compact?: 1-4, medium?: 1-8, expanded?: 1-12 }   absent = the grid places it
 *   hide   { compact?: boolean, medium?: boolean, expanded?: boolean }
 *
 * At one class a block starting at column s spans its span from there
 * (`grid-column: s / span n`), or, with no span, to the row's end (`s / -1`):
 * absent span still means "as wide as it can". A start and a span must fit
 * the class's columns together (s + n - 1 <= columns, `fitsPlacement`).
 *
 * The data half moved from app-bases `apps/ui-gallery/src/design/grid.ts`; how
 * a cell draws them (custom properties, the resize handle) stays in the app.
 * Pure: no React, no DOM.
 */

/** A page's width class (the page grammar's `PageWindowClass`). */
export type WidthClass = "compact" | "medium" | "expanded";

export const WIDTH_CLASSES: readonly WidthClass[] = [
  "compact",
  "medium",
  "expanded",
];

/** The page grid's columns per width class. */
export const GRID_COLUMNS: Readonly<Record<WidthClass, number>> = {
  compact: 4,
  medium: 8,
  expanded: 12,
};

/** The page grammar's breakpoints (container width, CSS px): below 600 compact, from 1024 expanded. */
export const WIDTH_CLASS_BREAKPOINTS = { medium: 600, expanded: 1024 } as const;

/** The width class a frame of this width is drawn at. */
export function widthClassOf(width: number): WidthClass {
  if (width >= WIDTH_CLASS_BREAKPOINTS.expanded) return "expanded";
  if (width >= WIDTH_CLASS_BREAKPOINTS.medium) return "medium";
  return "compact";
}

export const SPAN_PROP = "span";
export const START_PROP = "start";
export const HIDE_PROP = "hide";
/** The props every block has on top of its component's own (a component declaring one of them is refused it). */
export const GRID_PROPS: readonly string[] = [SPAN_PROP, START_PROP, HIDE_PROP];

export type Span = Partial<Record<WidthClass, number>>;
/** The column (1-based) a block starts at, per width class. */
export type Start = Partial<Record<WidthClass, number>>;
export type Hide = Partial<Record<WidthClass, boolean>>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export const isWidthClass = (k: unknown): k is WidthClass =>
  typeof k === "string" && (WIDTH_CLASSES as readonly string[]).includes(k);

/** A whole number of the columns this class has (1 to its columns). */
export const fitsSpan = (cls: WidthClass, n: unknown): n is number =>
  typeof n === "number" &&
  Number.isInteger(n) &&
  n >= 1 &&
  n <= GRID_COLUMNS[cls];

/**
 * A block starting at column `start` and spanning `span` columns (none: to
 * the row's end) stays inside this class's columns.
 */
export const fitsPlacement = (
  cls: WidthClass,
  start: number,
  span: number | undefined
): boolean => start + (span ?? 1) - 1 <= GRID_COLUMNS[cls];

/**
 * A `span`, `start` or `hide` value as stored: only width classes, a whole
 * number of the class's columns (1 to its columns) for `span` and `start`, a
 * boolean for `hide`. A class whose value is `undefined` is not set (an editor
 * field cleared; JSON never carries it). `value` keeps what fits (undefined
 * when nothing does); `bad` says something was left out, so the one door can
 * name it.
 */
export function cleanGridProp(
  prop: string,
  raw: unknown
): { value: Span | Start | Hide | undefined; bad: boolean } {
  if (!isObj(raw)) return { value: undefined, bad: true };
  const value: Record<string, number | boolean> = {};
  let bad = false;
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const fits =
      isWidthClass(k) &&
      (prop === HIDE_PROP ? typeof v === "boolean" : fitsSpan(k, v));
    if (fits) value[k] = v as number | boolean;
    else bad = true;
  }
  return { value: Object.keys(value).length > 0 ? value : undefined, bad };
}

/**
 * A block's cleaned `start` against its cleaned `span`: a class whose start
 * and span together run past the class's columns loses its start (the span
 * is the older, wider-known prop). Returns the start that fits (undefined
 * when none does) and whether one was left out. Pure.
 */
export function fitStartToSpan(
  start: Start | undefined,
  span: Span | undefined
): { value: Start | undefined; bad: boolean } {
  if (!start) return { value: undefined, bad: false };
  const value: Start = {};
  let bad = false;
  for (const cls of WIDTH_CLASSES) {
    const s = start[cls];
    if (s === undefined) continue;
    if (fitsPlacement(cls, s, span?.[cls])) value[cls] = s;
    else bad = true;
  }
  return { value: Object.keys(value).length > 0 ? value : undefined, bad };
}

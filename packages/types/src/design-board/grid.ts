/**
 * THE layout grid of a design page, as data (plan 0fc746f4 §2.4, decision
 * 0fe103c9: flow only). A page is a column grid: 12 columns at an expanded
 * width, 8 at medium, 4 at compact, the width classes of the page grammar
 * (600 / 1024, measured on the page's container).
 *
 * A block placed in a grid (a Section, or a Grid inside one) may say, per
 * width class, how many columns it spans and whether it is hidden: the only
 * per-width overrides a block has (D5). Both are props of the block:
 *
 *   span  { compact?: 1-4, medium?: 1-8, expanded?: 1-12 }   absent = full width
 *   hide  { compact?: boolean, medium?: boolean, expanded?: boolean }
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
export const HIDE_PROP = "hide";
/** The props every block has on top of its component's own (a component declaring one of them is refused it). */
export const GRID_PROPS: readonly string[] = [SPAN_PROP, HIDE_PROP];

export type Span = Partial<Record<WidthClass, number>>;
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
 * A `span` or `hide` value as stored: only width classes, a whole number of
 * columns the class has (1 to its columns) for `span`, a boolean for `hide`.
 * `value` keeps what fits (undefined when nothing does); `bad` says something
 * was left out, so the one door can name it.
 */
export function cleanGridProp(
  prop: string,
  raw: unknown
): { value: Span | Hide | undefined; bad: boolean } {
  if (!isObj(raw)) return { value: undefined, bad: true };
  const value: Record<string, number | boolean> = {};
  let bad = false;
  for (const [k, v] of Object.entries(raw)) {
    const fits =
      isWidthClass(k) &&
      (prop === SPAN_PROP ? fitsSpan(k, v) : typeof v === "boolean");
    if (fits) value[k] = v as number | boolean;
    else bad = true;
  }
  return { value: Object.keys(value).length > 0 ? value : undefined, bad };
}

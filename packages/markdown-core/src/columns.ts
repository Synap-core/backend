/**
 * COLUMNS — the one reading of a `synap-columns` row (columns.md §2).
 *
 *   :::::synap-columns
 *   ::::synap-column{width="40%"}
 *   …content…
 *   ::::
 *   ::::synap-column{width="60%"}
 *   …content…
 *   ::::
 *   :::::
 *
 * Writing is `serializeColumns` (embeds.ts, beside the other writers). This
 * module READS: the row's columns and their weights (`readColumns`), a width
 * read leniently (`readColumnWidth`), and what the row gets wrong
 * (`columnsDiagnostics`, folded into `collectDiagnostics`).
 *
 * Widths: WRITE strict (`formatColumnWidth`: an integer percentage from 15 to
 * 85), READ lenient (`40%`, `40`, `0.4`). Readers never validate a row away:
 * they normalize the weights (`columnWeights`, rendered as `fr`), so widths
 * that add up to 90 or 110 — which two concurrent resizes can produce — still
 * render proportionally.
 *
 * Every reader TOLERATES what the editor would not create (one column, an
 * empty column, more than `MAX_COLUMNS`): it renders it, and a diagnostic
 * names it.
 */

import type { RootContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import type { Diagnostic } from "./diagnostics.js";
import {
  COLUMN_DIRECTIVE,
  COLUMNS_DIRECTIVE,
  EmbedSerializeError,
  SECTION_DIRECTIVE,
  isLayoutDirective,
} from "./embeds.js";

/** The editor offers at most this many columns; readers render any number. */
export const MAX_COLUMNS = 3;
/** The strict write range of a column width, in percent. */
export const MIN_COLUMN_WIDTH = 15;
export const MAX_COLUMN_WIDTH = 85;

/**
 * A width attribute read leniently, as a percentage: `"40%"`, `"40"` and
 * `"0.4"` are all 40. Anything else (`"wide"`, `"0"`, `"140%"`) is null, and
 * the column takes an equal share (`columnWeights`).
 */
export function readColumnWidth(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(%?)\s*$/.exec(raw);
  if (!m) return null;
  let n = Number(m[1]);
  // A bare number at most 1 is a fraction (a weight), never "1 percent".
  if (!m[2] && n <= 1) n *= 100;
  return n > 0 && n <= 100 ? n : null;
}

/**
 * THE strict width writer for new widths: an integer percentage in
 * [MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH], written `"40%"`. Authored widths are
 * never re-formatted — `serializeColumns` writes them verbatim.
 */
export function formatColumnWidth(percent: number): string {
  if (
    !Number.isInteger(percent) ||
    percent < MIN_COLUMN_WIDTH ||
    percent > MAX_COLUMN_WIDTH
  ) {
    throw new EmbedSerializeError(
      `A column width is a whole percentage from ${MIN_COLUMN_WIDTH} to ${MAX_COLUMN_WIDTH} (got ${percent}).`
    );
  }
  return `${percent}%`;
}

/**
 * The relative weight of each column (render as `fr`). A column without a
 * readable width takes an equal share of what the others leave of 100; when
 * they leave nothing, the average of the others. No width at all = equal.
 */
export function columnWeights(
  widths: ReadonlyArray<string | null | undefined>
): number[] {
  const read = widths.map(readColumnWidth);
  const known = read.filter((w): w is number => w !== null);
  const missing = read.length - known.length;
  if (missing === 0) return read as number[];
  const sum = known.reduce((a, b) => a + b, 0);
  const share =
    known.length === 0
      ? 100 / missing
      : sum < 100
        ? (100 - sum) / missing
        : sum / known.length;
  return read.map((w) => w ?? share);
}

function isContainer(node: unknown, name: string): node is ContainerDirective {
  const n = node as { type?: string; name?: string } | undefined;
  return n?.type === "containerDirective" && n.name === name;
}

/** The `[label]` of a directive, which micromark puts first as a paragraph. */
function isLabel(node: unknown): boolean {
  const n = node as
    { type?: string; data?: { directiveLabel?: boolean } } | undefined;
  return n?.type === "paragraph" && n.data?.directiveLabel === true;
}

export interface ReadColumn {
  /** The `synap-column` node. */
  node: ContainerDirective;
  /** The width as written (`"40%"`), or null. */
  width: string | null;
  /** Its relative weight among its row (`columnWeights`). */
  weight: number;
  /** Its content. */
  children: RootContent[];
}

export interface ReadColumns {
  columns: ReadColumn[];
  /**
   * Children of the row that are not a column (`columns-stray-content`).
   * Readers render them full-width ABOVE the grid, never drop them.
   */
  stray: RootContent[];
}

/** Read a `synap-columns` node; null for any other node. */
export function readColumns(node: unknown): ReadColumns | null {
  if (!isContainer(node, COLUMNS_DIRECTIVE)) return null;
  const columnNodes: ContainerDirective[] = [];
  const stray: RootContent[] = [];
  for (const child of node.children) {
    if (isContainer(child, COLUMN_DIRECTIVE)) columnNodes.push(child);
    else stray.push(child as RootContent);
  }
  const widths = columnNodes.map((c) => {
    const w = c.attributes?.width;
    return typeof w === "string" && w !== "" ? w : null;
  });
  const weights = columnWeights(widths);
  return {
    columns: columnNodes.map((c, i) => ({
      node: c,
      width: widths[i]!,
      weight: weights[i]!,
      children: c.children.filter((k) => !isLabel(k)) as RootContent[],
    })),
    stray,
  };
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

type Walked = {
  type: string;
  name?: string;
  children?: Walked[];
  position?: { start: { line: number } };
};

/**
 * What a document's column rows get wrong (columns.md §2.8). Readers still
 * render every one of these; the codes tell an author (a person or an agent)
 * what to fix.
 */
export function columnsDiagnostics(tree: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (
    code: Diagnostic["code"],
    severity: Diagnostic["severity"],
    node: Walked,
    message: string
  ) =>
    out.push({
      code,
      severity,
      message,
      line: node.position?.start.line,
      directive: node.name,
    });

  const walk = (node: Walked, parent: Walked | null, inLayout: boolean) => {
    if (node.type === "containerDirective") {
      if (
        node.name === COLUMN_DIRECTIVE &&
        !isContainer(parent, COLUMNS_DIRECTIVE)
      ) {
        push(
          "orphan-column",
          "error",
          node,
          `\`${COLUMN_DIRECTIVE}\` sits outside a \`${COLUMNS_DIRECTIVE}\` row, so it renders as a plain block. Give the row a longer fence than its columns (e.g. \`:::::${COLUMNS_DIRECTIVE}\` around \`::::${COLUMN_DIRECTIVE}\`).`
        );
      }
      if (node.name === COLUMNS_DIRECTIVE && inLayout) {
        push(
          "nested-columns",
          "error",
          node,
          "Columns cannot hold another row of columns; the inner row renders stacked. Put the rows one after the other."
        );
      }
      if (node.name === SECTION_DIRECTIVE && inLayout) {
        push(
          "section-in-columns",
          "error",
          node,
          `A \`${SECTION_DIRECTIVE}\` inside columns is invisible to the section door. Put the columns inside the section instead.`
        );
      }
      const row = readColumns(node);
      if (row) rowDiagnostics(node, row, push);
    }
    const layout = inLayout || isLayoutDirective(node.name);
    for (const child of node.children ?? []) walk(child, node, layout);
  };
  walk(tree as Walked, null, false);
  return out;
}

function rowDiagnostics(
  node: Walked,
  row: ReadColumns,
  push: (
    code: Diagnostic["code"],
    severity: Diagnostic["severity"],
    node: Walked,
    message: string
  ) => void
): void {
  const stray = row.stray.filter((c) => !isLabel(c));
  if (stray.length > 0) {
    push(
      "columns-stray-content",
      "warning",
      stray[0] as Walked,
      `Content inside \`${COLUMNS_DIRECTIVE}\` but outside any \`${COLUMN_DIRECTIVE}\` renders full-width above the row. Move it into a column.`
    );
  }
  const n = row.columns.length;
  if (n > MAX_COLUMNS) {
    push(
      "too-many-columns",
      "warning",
      node,
      `This row has ${n} columns; a row holds at most ${MAX_COLUMNS}. Split it into two rows.`
    );
  } else if (n === 1) {
    push(
      "single-column",
      "info",
      node,
      "This row has a single column, so it renders as ordinary flow. Add a column or unwrap it."
    );
  }
  for (const column of row.columns) {
    if (column.children.length === 0) {
      push(
        "empty-column",
        "info",
        column.node as unknown as Walked,
        "This column is empty (its width is kept as white space)."
      );
    }
  }
  const written = row.columns.filter((c) => c.width !== null);
  const unreadable = written.filter((c) => readColumnWidth(c.width) === null);
  for (const column of unreadable) {
    push(
      "invalid-width",
      "info",
      column.node as unknown as Walked,
      `\`width="${column.width}"\` is not a width, so the column takes an equal share. Write a percentage such as \`width="40%"\`.`
    );
  }
  if (unreadable.length > 0) return;
  if (written.length > 0 && written.length < n) {
    push(
      "invalid-width",
      "info",
      node,
      "Only some columns have a width: give every column one, or none."
    );
    return;
  }
  if (written.length === n && n > 1) {
    const sum = written.reduce((a, c) => a + readColumnWidth(c.width)!, 0);
    if (Math.abs(sum - 100) > 1) {
      push(
        "invalid-width",
        "info",
        node,
        `The widths add up to ${Math.round(sum)}%, so readers scale them. Make them add up to 100%.`
      );
    }
  }
}

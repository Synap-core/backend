/**
 * `synap_capture`'s columnar `table` shape (ticket a8884743, plan B2).
 *
 * An agent holding a register (57 expense lines, each with a receipt number)
 * sends it as ONE table instead of 57 repeated JSON objects:
 *
 *   { profileSlug: "expense", columns: ["title", "amount", "receipt"],
 *     rows: [["Train Paris-Lyon", 42, "R-0012"], ...],
 *     linkBy: [{ column: "receipt", profileSlug: "document",
 *                property: "receipt", type: "references" }] }
 *
 * It is expanded HERE into the same `entities[]` + `relations[]` graph the
 * capture door already files as one proposal: no new door, no new pipeline.
 * Each row is a new entity of `profileSlug` (column `title` its title,
 * `description` / `content` those fields, every other column a property).
 * Each `linkBy` resolves a cell to the existing entity of `profileSlug` whose
 * `property` equals it EXACTLY (founder, 18 Nov 2026: exact match only) and
 * becomes a relation to that entity through `existingEntityId`. A cell that
 * matches nothing, or more than one entity, is never guessed: it comes back in
 * the report, by row.
 *
 * Bounded by {@link CAPTURE_TABLE_MAX_ROWS} (founder, 18 Nov 2026: 500 rows
 * per call); a bigger table is refused by name, before any read.
 *
 * Pure (the tool schema reads the cap from here); the one database read, the
 * `linkBy` lookup, is `capture-table-links.ts`.
 */

/** Rows one `table` may carry in a single capture call. */
export const CAPTURE_TABLE_MAX_ROWS = 500;

/** Columns read as entity fields rather than properties. */
const FIELD_COLUMNS = new Set(["title", "description", "content"]);

/** Per-row problems listed before the rest are counted. */
const ROW_PROBLEMS_LISTED = 10;

export interface CaptureTableLinkBy {
  /** The table column whose cell names the existing entity. */
  column: string;
  /** The existing entity's kind. */
  profileSlug: string;
  /** The existing entity's property the cell must equal. */
  property: string;
  /** The relation slug from the row to the existing entity. */
  type: string;
}

export interface CaptureTable {
  profileSlug: string;
  columns: string[];
  rows: unknown[][];
  linkBy: CaptureTableLinkBy[];
}

export type ParsedCaptureTable =
  | { ok: true; table: CaptureTable }
  | {
      ok: false;
      problems: string[];
      /** Set when the table is refused for its size alone. */
      limit?: { name: "CAPTURE_TABLE_MAX_ROWS"; max: number; rows: number };
    };

const isText = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** The shape check: every problem at once, the row cap first and alone. */
export function parseCaptureTable(raw: unknown): ParsedCaptureTable {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      problems: ["`table` must be an object { profileSlug, columns, rows }"],
    };
  }
  const t = raw as Record<string, unknown>;
  if (Array.isArray(t.rows) && t.rows.length > CAPTURE_TABLE_MAX_ROWS) {
    return {
      ok: false,
      problems: [
        `table has ${t.rows.length} rows: at most ${CAPTURE_TABLE_MAX_ROWS} per call (CAPTURE_TABLE_MAX_ROWS). Send it in calls of ${CAPTURE_TABLE_MAX_ROWS} rows or fewer.`,
      ],
      limit: {
        name: "CAPTURE_TABLE_MAX_ROWS",
        max: CAPTURE_TABLE_MAX_ROWS,
        rows: t.rows.length,
      },
    };
  }
  const problems: string[] = [];
  if (!isText(t.profileSlug)) {
    problems.push(
      "table needs a `profileSlug`: the kind every row becomes (discover slugs with synap_list_profiles)"
    );
  }
  const columns = Array.isArray(t.columns) ? t.columns : null;
  if (!columns || columns.length === 0 || !columns.every(isText)) {
    problems.push("table.columns must be a non-empty list of column names");
  } else {
    const seen = new Set<string>();
    for (const c of columns as string[]) {
      if (seen.has(c)) problems.push(`table.columns names "${c}" twice`);
      seen.add(c);
    }
    if (!seen.has("title")) {
      problems.push(
        "table.columns needs a `title` column: it names each row's entity"
      );
    }
  }
  const rows = Array.isArray(t.rows) ? t.rows : null;
  if (!rows || rows.length === 0) {
    problems.push("table.rows must be a non-empty list of rows");
  }
  const rowProblems: string[] = [];
  if (rows && columns) {
    const titleAt = (columns as unknown[]).indexOf("title");
    rows.forEach((row, i) => {
      if (!Array.isArray(row)) {
        rowProblems.push(`table.rows[${i}] must be a list of cells`);
      } else if (row.length !== columns.length) {
        rowProblems.push(
          `table.rows[${i}] has ${row.length} cells; columns has ${columns.length}`
        );
      } else if (titleAt >= 0 && cellText(row[titleAt]) === null) {
        rowProblems.push(`table.rows[${i}] has an empty title`);
      }
    });
  }
  problems.push(...rowProblems.slice(0, ROW_PROBLEMS_LISTED));
  if (rowProblems.length > ROW_PROBLEMS_LISTED) {
    problems.push(
      `and ${rowProblems.length - ROW_PROBLEMS_LISTED} more rows with the same kinds of problem`
    );
  }
  const linkByRaw = t.linkBy === undefined ? [] : t.linkBy;
  const linkBy: CaptureTableLinkBy[] = [];
  if (!Array.isArray(linkByRaw)) {
    problems.push("table.linkBy must be a list");
  } else {
    linkByRaw.forEach((l, i) => {
      const spec = (l ?? {}) as Record<string, unknown>;
      if (
        !isText(spec.column) ||
        !isText(spec.profileSlug) ||
        !isText(spec.property) ||
        !isText(spec.type)
      ) {
        problems.push(
          `table.linkBy[${i}] needs \`column\`, \`profileSlug\`, \`property\` and \`type\``
        );
        return;
      }
      if (columns && !columns.includes(spec.column)) {
        problems.push(
          `table.linkBy[${i}].column "${spec.column}" is not one of table.columns`
        );
        return;
      }
      linkBy.push({
        column: spec.column,
        profileSlug: spec.profileSlug,
        property: spec.property,
        type: spec.type,
      });
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    table: {
      profileSlug: t.profileSlug as string,
      columns: columns as string[],
      rows: rows as unknown[][],
      linkBy,
    },
  };
}

/** A cell as the text an exact match compares, or null for an empty cell. */
export function cellText(cell: unknown): string | null {
  if (typeof cell === "number" && Number.isFinite(cell)) return String(cell);
  if (typeof cell === "string" && cell.trim() !== "") return cell.trim();
  return null;
}

/**
 * A `linkBy` cell as the value it must equal: a number as its text, a string
 * exactly as sent (never trimmed or case-folded: exact match only), or null
 * for an empty cell, which links nothing.
 */
export function linkValue(cell: unknown): string | null {
  if (typeof cell === "number" && Number.isFinite(cell)) return String(cell);
  if (typeof cell === "string" && cell.trim() !== "") return cell;
  return null;
}

/** The existing entities whose `property` equals a value, per value. */
export type LinkByMatches = Map<string, string[]>;

export interface CaptureTableReport {
  rows: number;
  /** Per `linkBy`: rows linked, and every cell left unlinked, by row index. */
  linkBy: Array<{
    column: string;
    linked: number;
    unmatched: Array<{ row: number; value: string }>;
    ambiguous: Array<{ row: number; value: string; entityIds: string[] }>;
  }>;
}

export interface ExpandedCaptureTable {
  entities: Array<Record<string, unknown> & { ref: string }>;
  relations: Array<{ sourceRef: string; targetRef: string; type: string }>;
  report: CaptureTableReport;
}

/**
 * The table as graph entities and relations. Row `i` is ref `rows[i]`, so a
 * problem or a title lint names the row it came from; an existing entity is
 * ref `existing:<id>`, one per entity however many rows link to it.
 */
export function expandCaptureTable(
  table: CaptureTable,
  matchesByLink: ReadonlyArray<LinkByMatches>
): ExpandedCaptureTable {
  const graphEntities: ExpandedCaptureTable["entities"] = [];
  const relations: ExpandedCaptureTable["relations"] = [];
  const existingRefs = new Set<string>();
  table.rows.forEach((row, i) => {
    const entity: Record<string, unknown> & { ref: string } = {
      ref: `rows[${i}]`,
      profileSlug: table.profileSlug,
    };
    const properties: Record<string, unknown> = {};
    table.columns.forEach((column, c) => {
      const cell = row[c];
      if (cell === null || cell === undefined || cell === "") return;
      if (FIELD_COLUMNS.has(column)) {
        const text = cellText(cell);
        if (text !== null) entity[column] = text;
      } else {
        properties[column] = cell;
      }
    });
    if (Object.keys(properties).length > 0) entity.properties = properties;
    graphEntities.push(entity);
  });
  const report: CaptureTableReport = { rows: table.rows.length, linkBy: [] };
  table.linkBy.forEach((spec, l) => {
    const at = table.columns.indexOf(spec.column);
    const matches = matchesByLink[l] ?? new Map<string, string[]>();
    const outcome: CaptureTableReport["linkBy"][number] = {
      column: spec.column,
      linked: 0,
      unmatched: [],
      ambiguous: [],
    };
    table.rows.forEach((row, i) => {
      const value = linkValue(row[at]);
      if (value === null) return;
      const ids = matches.get(value) ?? [];
      if (ids.length === 0) {
        outcome.unmatched.push({ row: i, value });
        return;
      }
      if (ids.length > 1) {
        outcome.ambiguous.push({ row: i, value, entityIds: ids });
        return;
      }
      const targetRef = `existing:${ids[0]}`;
      if (!existingRefs.has(targetRef)) {
        existingRefs.add(targetRef);
        graphEntities.push({
          ref: targetRef,
          profileSlug: spec.profileSlug,
          existingEntityId: ids[0],
        });
      }
      relations.push({ sourceRef: `rows[${i}]`, targetRef, type: spec.type });
      outcome.linked++;
    });
    report.linkBy.push(outcome);
  });
  return { entities: graphEntities, relations, report };
}

/** The distinct non-empty cells of one column: what its `linkBy` looks up. */
export function linkByValues(
  table: CaptureTable,
  spec: CaptureTableLinkBy
): string[] {
  const at = table.columns.indexOf(spec.column);
  const values = new Set<string>();
  for (const row of table.rows) {
    const value = linkValue(row[at]);
    if (value !== null) values.add(value);
  }
  return [...values];
}

/** Whether the report holds a cell the write will not link. */
export function tableHasUnlinkedCells(report: CaptureTableReport): boolean {
  return report.linkBy.some(
    (l) => l.unmatched.length > 0 || l.ambiguous.length > 0
  );
}

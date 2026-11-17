import { describe, it, expect } from "vitest";
import {
  CAPTURE_TABLE_MAX_ROWS,
  expandCaptureTable,
  linkByValues,
  parseCaptureTable,
  type CaptureTable,
} from "./capture-table.js";

/**
 * `synap_capture`'s `table` shape (ticket a8884743): the shape check, the row
 * cap, and the expansion into the capture graph. The door-level proof (one
 * proposal, through the real handler) is `capture.table.test.ts`.
 */

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => [`Line ${i}`, i, `R-${i}`]);

describe("parseCaptureTable", () => {
  it(`refuses more than ${CAPTURE_TABLE_MAX_ROWS} rows by the cap's name`, () => {
    const parsed = parseCaptureTable({
      profileSlug: "expense",
      columns: ["title", "amount", "receipt"],
      rows: rows(CAPTURE_TABLE_MAX_ROWS + 1),
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.limit).toEqual({
      name: "CAPTURE_TABLE_MAX_ROWS",
      max: 500,
      rows: 501,
    });
    expect(parsed.problems[0]).toContain("CAPTURE_TABLE_MAX_ROWS");
    expect(parsed.problems[0]).toContain("501 rows");
  });

  it(`accepts exactly ${CAPTURE_TABLE_MAX_ROWS} rows`, () => {
    const parsed = parseCaptureTable({
      profileSlug: "expense",
      columns: ["title", "amount", "receipt"],
      rows: rows(CAPTURE_TABLE_MAX_ROWS),
    });
    expect(parsed.ok).toBe(true);
  });

  it("reports every shape problem at once", () => {
    const parsed = parseCaptureTable({
      columns: ["amount", "amount"],
      rows: [[1], ["", 2]],
      linkBy: [{ column: "receipt", profileSlug: "document" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const text = parsed.problems.join("\n");
    expect(text).toContain("needs a `profileSlug`");
    expect(text).toContain('names "amount" twice');
    expect(text).toContain("needs a `title` column");
    expect(text).toContain("table.rows[0] has 1 cells; columns has 2");
    expect(text).toContain("table.linkBy[0] needs");
  });

  it("refuses a row with an empty title and a linkBy column the table lacks", () => {
    const parsed = parseCaptureTable({
      profileSlug: "expense",
      columns: ["title", "amount"],
      rows: [["  ", 3]],
      linkBy: [
        {
          column: "receipt",
          profileSlug: "document",
          property: "receipt",
          type: "references",
        },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const text = parsed.problems.join("\n");
    expect(text).toContain("table.rows[0] has an empty title");
    expect(text).toContain('column "receipt" is not one of table.columns');
  });
});

describe("expandCaptureTable", () => {
  const table: CaptureTable = {
    profileSlug: "expense",
    columns: ["title", "description", "amount", "receipt"],
    rows: [
      ["Train", "Paris to Lyon", 42, "R-1"],
      ["Hotel", "", 120, "R-2"],
      ["Taxi", null, 18, "R-404"],
      ["Lunch", null, 25, "R-dup"],
      ["Coffee", null, 3, ""],
      ["Dinner", null, 60, 1],
    ],
    linkBy: [
      {
        column: "receipt",
        profileSlug: "document",
        property: "receipt",
        type: "references",
      },
    ],
  };
  const matches = new Map<string, string[]>([
    ["R-1", ["doc-1"]],
    ["R-2", ["doc-1"]],
    ["R-dup", ["doc-a", "doc-b"]],
    ["1", ["doc-num"]],
  ]);

  it("asks for each distinct non-empty cell once, numbers as text", () => {
    expect(linkByValues(table, table.linkBy[0]!)).toEqual([
      "R-1",
      "R-2",
      "R-404",
      "R-dup",
      "1",
    ]);
  });

  it("matches exactly: a cell differing by case or spaces is unmatched, never guessed", () => {
    const near: CaptureTable = {
      ...table,
      rows: [
        ["Train", null, 42, "r-1"],
        ["Hotel", null, 120, " R-1"],
      ],
    };
    expect(linkByValues(near, near.linkBy[0]!)).toEqual(["r-1", " R-1"]);
    const out = expandCaptureTable(near, [matches]);
    expect(out.relations).toEqual([]);
    expect(out.report.linkBy[0]!.unmatched).toEqual([
      { row: 0, value: "r-1" },
      { row: 1, value: " R-1" },
    ]);
  });

  it("makes one entity per row, links matched cells, and reports the rest by row", () => {
    const out = expandCaptureTable(table, [matches]);
    const rowsOut = out.entities.filter((e) => e.ref.startsWith("rows["));
    expect(rowsOut).toHaveLength(6);
    expect(rowsOut[0]).toEqual({
      ref: "rows[0]",
      profileSlug: "expense",
      title: "Train",
      description: "Paris to Lyon",
      properties: { amount: 42, receipt: "R-1" },
    });
    // An empty cell is left out, never stored as "".
    expect(rowsOut[1]).toEqual({
      ref: "rows[1]",
      profileSlug: "expense",
      title: "Hotel",
      properties: { amount: 120, receipt: "R-2" },
    });
    // One linked entity per existing id, however many rows point at it.
    const existing = out.entities.filter((e) => e.existingEntityId);
    expect(existing).toEqual([
      {
        ref: "existing:doc-1",
        profileSlug: "document",
        existingEntityId: "doc-1",
      },
      {
        ref: "existing:doc-num",
        profileSlug: "document",
        existingEntityId: "doc-num",
      },
    ]);
    expect(out.relations).toEqual([
      { sourceRef: "rows[0]", targetRef: "existing:doc-1", type: "references" },
      { sourceRef: "rows[1]", targetRef: "existing:doc-1", type: "references" },
      {
        sourceRef: "rows[5]",
        targetRef: "existing:doc-num",
        type: "references",
      },
    ]);
    expect(out.report).toEqual({
      rows: 6,
      linkBy: [
        {
          column: "receipt",
          linked: 3,
          unmatched: [{ row: 2, value: "R-404" }],
          ambiguous: [
            { row: 3, value: "R-dup", entityIds: ["doc-a", "doc-b"] },
          ],
        },
      ],
    });
  });
});

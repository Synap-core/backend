/**
 * REAL-POSTGRES (PGlite) test for migration 0457: a stored cell type gains
 * `status`, `fallback`, `placements` and `anchor_kinds`, and its lifecycle is
 * backfilled from `is_active`.
 *
 * Claims: an active row reads `active`, a retired row (`is_active = false`)
 * reads `retired`; the three new descriptive columns are NULL (no narrowing);
 * a second run changes nothing (a row a writer moved to `draft` since stays
 * `draft`); a row inserted after the migration defaults to `active`; the
 * baseline declares the same four columns.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0457 = readFileSync(
  resolve(HERE, "../migrations/0457_cell_type_lifecycle_columns.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);

async function table(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "widget_definitions" (
      "id" serial PRIMARY KEY,
      "type_key" text NOT NULL,
      "is_active" boolean NOT NULL DEFAULT true
    );
    INSERT INTO widget_definitions (type_key, is_active) VALUES
      ('live-cell', true), ('retired-cell', false);`);
  return pg;
}

type Row = {
  type_key: string;
  status: string;
  fallback: string | null;
  placements: unknown;
  anchor_kinds: unknown;
};

const rows = async (pg: PGlite) =>
  (
    await pg.query<Row>(
      `SELECT type_key, status, fallback, placements, anchor_kinds FROM widget_definitions ORDER BY id`
    )
  ).rows;

describe("migration 0457: cell type lifecycle columns", () => {
  it("backfills status from is_active and adds the descriptive columns empty", async () => {
    const pg = await table();
    await pg.exec(M0457);
    expect(await rows(pg)).toEqual([
      {
        type_key: "live-cell",
        status: "active",
        fallback: null,
        placements: null,
        anchor_kinds: null,
      },
      {
        type_key: "retired-cell",
        status: "retired",
        fallback: null,
        placements: null,
        anchor_kinds: null,
      },
    ]);
  });

  it("is idempotent and leaves a status a writer set since", async () => {
    const pg = await table();
    await pg.exec(M0457);
    await pg.exec(
      `UPDATE widget_definitions SET status = 'draft' WHERE type_key = 'live-cell'`
    );
    await pg.exec(M0457);
    expect((await rows(pg)).map((r) => r.status)).toEqual(["draft", "retired"]);
  });

  it("a row written after the migration is active by default", async () => {
    const pg = await table();
    await pg.exec(M0457);
    await pg.exec(
      `INSERT INTO widget_definitions (type_key) VALUES ('new-cell')`
    );
    expect((await rows(pg)).at(-1)?.status).toBe("active");
  });

  it("the baseline declares the same four columns", () => {
    for (const column of ["status", "fallback", "placements", "anchor_kinds"]) {
      expect(BASELINE).toMatch(
        new RegExp(
          `ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "${column}"`
        )
      );
    }
  });
});

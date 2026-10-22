/**
 * REAL-POSTGRES (PGlite) test for migration 0348 — `entities.home_workspace_id`,
 * the space a POD-WIDE entity was filed for:
 *  - idempotent (applied twice) on a pre-0348 `entities`;
 *  - the CHECK refuses a home on a workspace row (a pod-wide row only);
 *  - the FK sets the home NULL when its space is deleted;
 *  - the read floor's partial index exists;
 *  - the Drizzle schema declares the column, the fresh-DB baseline carries the
 *    same DDL, and the boot coherence list names it, attributed to 0348.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { entities } from "./schema/entities.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const FILE = "0348_entities_home_workspace.sql";
const MIGRATION = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

const W = "a0000000-0000-4000-8000-000000000001";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE workspaces (id uuid PRIMARY KEY);
    CREATE TABLE entities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, deleted_at timestamptz);
    INSERT INTO workspaces (id) VALUES ('${W}');
    INSERT INTO entities (workspace_id) VALUES (NULL), ('${W}');
  `);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

const sqlState = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
};

describe("0348 entities.home_workspace_id", () => {
  it("keeps existing rows un-homed (no backfill)", async () => {
    const r = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM entities WHERE home_workspace_id IS NOT NULL`
    );
    expect(r.rows[0]!.n).toBe(0);
  });

  it("a pod-wide row may carry a home; a workspace row may not (CHECK)", async () => {
    expect(
      await sqlState(
        pg.query(
          `INSERT INTO entities (workspace_id, home_workspace_id) VALUES (NULL, '${W}')`
        )
      )
    ).toBeNull();
    // 23514 = check_violation.
    expect(
      await sqlState(
        pg.query(
          `INSERT INTO entities (workspace_id, home_workspace_id) VALUES ('${W}', '${W}')`
        )
      )
    ).toBe("23514");
    // Moving a homed row INTO a space without clearing the home is refused too.
    expect(
      await sqlState(
        pg.query(
          `UPDATE entities SET workspace_id = '${W}' WHERE home_workspace_id IS NOT NULL`
        )
      )
    ).toBe("23514");
  });

  it("deleting the home space un-homes the row (FK ON DELETE SET NULL)", async () => {
    const other = "a0000000-0000-4000-8000-000000000002";
    await pg.query(`INSERT INTO workspaces (id) VALUES ('${other}')`);
    const { rows } = await pg.query<{ id: string }>(
      `INSERT INTO entities (home_workspace_id) VALUES ('${other}') RETURNING id`
    );
    await pg.query(`DELETE FROM workspaces WHERE id = '${other}'`);
    const after = await pg.query<{ home: string | null }>(
      `SELECT home_workspace_id AS home FROM entities WHERE id = $1`,
      [rows[0]!.id]
    );
    expect(after.rows[0]!.home).toBeNull();
    // 23503 = foreign_key_violation: a home must name a real space.
    expect(
      await sqlState(
        pg.query(
          `INSERT INTO entities (home_workspace_id) VALUES ('a0000000-0000-4000-8000-0000000000ff')`
        )
      )
    ).toBe("23503");
  });

  it("creates the read floor's partial index", async () => {
    const r = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'entities_home_workspace_idx'`
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.indexdef).toMatch(/workspace_id IS NULL/);
  });

  it("the Drizzle schema, the baseline and the coherence list all carry it", () => {
    const cols = getTableConfig(entities).columns.map((c) => c.name);
    expect(cols).toContain("home_workspace_id");
    for (const needle of [
      `ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "home_workspace_id" uuid;`,
      `entities_home_workspace_id_fkey`,
      `entities_home_workspace_pod_wide_check`,
      `CREATE INDEX IF NOT EXISTS "entities_home_workspace_idx"`,
    ]) {
      expect(MIGRATION).toContain(needle);
      expect(BASELINE).toContain(needle);
    }
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "entities",
        column: "home_workspace_id",
        addedBy: FILE,
      })
    );
  });
});

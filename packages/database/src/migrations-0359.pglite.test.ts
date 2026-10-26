/**
 * REAL-POSTGRES (PGlite) test for migration 0359 — `entities.last_interaction_at`,
 * when we last spoke to someone (CRM recall C-W2):
 *  - idempotent (applied twice) on a pre-0359 `entities`, no backfill;
 *  - the list index exists (profile, value), live rows only;
 *  - the Drizzle schema declares the column, the fresh-DB baseline carries the
 *    same DDL, and the boot coherence list names it, attributed to 0359.
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
const FILE = "0359_entities_last_interaction_at.sql";
const MIGRATION = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE entities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid, deleted_at timestamptz);
    INSERT INTO entities DEFAULT VALUES;
  `);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

describe("0359 entities.last_interaction_at", () => {
  it("adds a nullable timestamptz, every existing row = never", async () => {
    const r = await pg.query<{ n: number; type: string }>(
      `SELECT (SELECT count(*)::int FROM entities WHERE last_interaction_at IS NOT NULL) AS n,
              (SELECT data_type FROM information_schema.columns
                WHERE table_name = 'entities' AND column_name = 'last_interaction_at') AS type`
    );
    expect(r.rows[0]).toEqual({ n: 0, type: "timestamp with time zone" });
  });

  it("creates the list index on live rows", async () => {
    const r = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'entities_profile_last_interaction_idx'`
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.indexdef).toMatch(/profile_id, last_interaction_at/);
    expect(r.rows[0]!.indexdef).toMatch(/deleted_at IS NULL/);
  });

  it("the Drizzle schema, the baseline and the coherence list all carry it", () => {
    const cols = getTableConfig(entities).columns.map((c) => c.name);
    expect(cols).toContain("last_interaction_at");
    for (const needle of [
      `ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "last_interaction_at" timestamptz;`,
      `CREATE INDEX IF NOT EXISTS "entities_profile_last_interaction_idx"`,
    ]) {
      expect(MIGRATION).toContain(needle);
      expect(BASELINE).toContain(needle);
    }
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "entities",
        column: "last_interaction_at",
        addedBy: FILE,
      })
    );
  });
});

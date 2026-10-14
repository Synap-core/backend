/**
 * REAL-POSTGRES (PGlite) test for migration 0328 — the Library.
 * The migration and the baseline create `library_groups` with EVERY column and
 * index the drizzle schema declares, the documents read index the schema
 * declares (schema-coherence checks both by name), and re-running is a no-op.
 * The partial index is USED by the read model's query shape.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { libraryGroups } from "./schema/library-groups.js";
import { documents } from "./schema/documents.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0328 = readFileSync(
  resolve(HERE, "../migrations/0328_library_groups.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);
const groupCfg = getTableConfig(libraryGroups);
const declaredColumns = groupCfg.columns.map((c) => c.name);
const declaredGroupIndexes = groupCfg.indexes.map((i) => i.config.name!);
const declaredDocIndex = getTableConfig(documents)
  .indexes.map((i) => i.config.name!)
  .find((n) => n === "documents_library_items_idx");

const DOCUMENTS_STUB = `CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, metadata jsonb)`;

async function indexesOf(pg: PGlite, table: string): Promise<string[]> {
  const r = await pg.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
    [table]
  );
  return r.rows.map((x) => x.indexname);
}

describe("migration 0328 — library_groups + the Library read index", () => {
  it("creates every declared column and index, idempotently", async () => {
    const pg = new PGlite();
    await pg.exec(DOCUMENTS_STUB);
    await pg.exec(M0328);
    await pg.exec(M0328);
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'library_groups'`
    );
    expect(declaredColumns.length).toBe(15);
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      [...declaredColumns].sort()
    );
    expect(declaredGroupIndexes.length).toBe(2);
    const groupIdx = await indexesOf(pg, "library_groups");
    for (const name of declaredGroupIndexes) expect(groupIdx).toContain(name);
    expect(declaredDocIndex).toBe("documents_library_items_idx");
    expect(await indexesOf(pg, "documents")).toContain(declaredDocIndex);
    await pg.close();
  }, 60_000);

  it("refuses a second group with the same key for one person, allows it for another", async () => {
    const pg = new PGlite();
    await pg.exec(DOCUMENTS_STUB);
    await pg.exec(M0328);
    await pg.query(
      `INSERT INTO library_groups (user_id, key, name) VALUES ('u1','films','Films')`
    );
    await pg.query(
      `INSERT INTO library_groups (user_id, key, name) VALUES ('u2','films','Films')`
    );
    await expect(
      pg.query(
        `INSERT INTO library_groups (user_id, key, name) VALUES ('u1','films','Films 2')`
      )
    ).rejects.toThrow(/library_groups_user_key_unique/);
    await expect(
      pg.query(
        `INSERT INTO library_groups (user_id, key, name, origin) VALUES ('u1','x','X','agent')`
      )
    ).rejects.toThrow(/library_groups_origin_check/);
    await pg.close();
  }, 60_000);

  it("the baseline carries the same table and the documents read index", () => {
    const create = M0328.slice(
      M0328.indexOf('CREATE TABLE IF NOT EXISTS "library_groups"'),
      M0328.indexOf(");", M0328.indexOf("CREATE TABLE")) + 2
    );
    expect(create.length).toBeGreaterThan(200);
    expect(BASELINE).toContain(create.trim());
    expect(BASELINE).toContain('"documents_library_items_idx"');
    expect(BASELINE).toContain('"library_groups_user_key_unique"');
  });
});

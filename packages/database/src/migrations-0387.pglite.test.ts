/**
 * REAL-POSTGRES (PGlite) test for migration 0387 — `documents.scope` and
 * `documents.refresh_automation_id` (Generative UI wave 1, contracts 3 and 4).
 * Both nullable, no backfill. The migration is idempotent, the binding unbinds
 * itself when its automation is deleted, and the baseline carries both
 * columns, so baseline and migration match the drizzle schema.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { documents } from "./schema/documents.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0387 = read("0387_document_scope_refresher.sql");
const BASELINE = read("0000_baseline_schema.sql");

/**
 * The baseline's documents table: its CREATE and column guards, plus every
 * `ALTER TABLE documents ADD COLUMN` the baseline makes further down (the
 * provenance columns), read from the file, never hand-listed.
 */
const DOCS_BLOCK =
  BASELINE.slice(
    BASELINE.indexOf('CREATE TABLE IF NOT EXISTS "documents" ('),
    BASELINE.indexOf('CREATE INDEX IF NOT EXISTS "documents_user_id_idx"')
  ) +
  "\n" +
  BASELINE.split("\n")
    .filter((l) => /^ALTER TABLE documents ADD COLUMN/.test(l))
    .map((l) => l.replace(/\s+REFERENCES[^;]*/, ""))
    .join("\n");
/** Just enough of `automations` for the FK. */
const AUTOMATIONS = `CREATE TABLE IF NOT EXISTS "automations" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid());`;

const NEW_COLUMNS = ["scope", "refresh_automation_id"];

const columns = async (client: PGlite) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'`
    )
  ).rows.map((r) => r.column_name);

describe("migration 0387 — documents.scope / refresh_automation_id", () => {
  it("non-vacuous: the baseline block is the documents table", () => {
    expect(DOCS_BLOCK).toContain('"content_revision"');
    expect(DOCS_BLOCK.length).toBeGreaterThan(500);
  });

  it("adds both nullable columns, twice without error, keeping existing rows; a deleted automation unbinds", async () => {
    const pg = new PGlite();
    await pg.exec(AUTOMATIONS);
    // A pod before 0387: the baseline section WITHOUT the new columns.
    await pg.exec(
      DOCS_BLOCK.split("\n")
        .filter((l) => !NEW_COLUMNS.some((c) => l.includes(`"${c}"`)))
        .join("\n")
    );
    for (const c of NEW_COLUMNS) expect(await columns(pg)).not.toContain(c);
    await pg.exec(
      `INSERT INTO documents (user_id, workspace_id, title, type)
       VALUES ('u1', '11111111-1111-4111-8111-111111111111', 'Old', 'markdown')`
    );

    await pg.exec(M0387);
    await pg.exec(M0387);

    const { rows } = await pg.query<Record<string, unknown>>(
      `SELECT scope, refresh_automation_id FROM documents`
    );
    expect(rows).toEqual([{ scope: null, refresh_automation_id: null }]);

    const {
      rows: [auto],
    } = await pg.query<{ id: string }>(
      `INSERT INTO automations DEFAULT VALUES RETURNING id`
    );
    await pg.query(
      `UPDATE documents SET refresh_automation_id = $1, scope = $2`,
      [auto!.id, JSON.stringify({ kind: "pod" })]
    );
    await pg.query(`DELETE FROM automations WHERE id = $1`, [auto!.id]);
    const { rows: after } = await pg.query<Record<string, unknown>>(
      `SELECT scope, refresh_automation_id FROM documents`
    );
    expect(after).toEqual([
      { scope: { kind: "pod" }, refresh_automation_id: null },
    ]);
    await pg.close();
  });

  it("the baseline and the migration both match every column the schema declares", async () => {
    const declared = getTableConfig(documents)
      .columns.map((c) => c.name)
      .sort();
    for (const c of NEW_COLUMNS) expect(declared).toContain(c);

    const base = new PGlite();
    await base.exec(AUTOMATIONS);
    await base.exec(DOCS_BLOCK);
    expect((await columns(base)).sort()).toEqual(declared);
    await base.exec(M0387);
    expect((await columns(base)).sort()).toEqual(declared);
    await base.close();
  });
});

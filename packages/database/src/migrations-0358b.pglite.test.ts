/**
 * REAL-POSTGRES (PGlite) test for migration 0358b — document passages (recall
 * plan A-W2). The migration and the baseline create `document_passages` and
 * `document_passage_state` with EVERY column and index the drizzle schema
 * declares, schema-coherence names them, re-running is a no-op, one row per
 * (document, ordinal), and a deleted document takes its passages and state.
 *
 * PGlite here has no pgvector: the `vector(1536)` column runs as `text` and
 * the HNSW statement is checked as text (CI migrates a real pgvector Postgres
 * and runs the coherence check on it).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  documentPassages,
  documentPassageState,
} from "./schema/document-passages.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0358 = read("0358b_document_passages.sql");
const BASELINE = read("0000_baseline_schema.sql");

const HNSW = `CREATE INDEX IF NOT EXISTS "document_passages_embedding_hnsw_idx"
  ON "document_passages" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);`;

/** The migration as PGlite can run it: no pgvector type, no HNSW. */
const RUNNABLE = M0358.replace("vector(1536)", "text").replace(HNSW, "");

const DOCUMENTS_STUB = `CREATE TABLE documents (id uuid PRIMARY KEY)`;

const columnsOf = async (pg: PGlite, table: string) =>
  (
    await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    )
  ).rows
    .map((r) => r.column_name)
    .sort();

describe("migration 0358b — document_passages + document_passage_state", () => {
  it("creates every declared column and index, idempotently", async () => {
    expect(RUNNABLE).not.toContain("hnsw");
    const pg = new PGlite();
    await pg.exec(DOCUMENTS_STUB);
    await pg.exec(RUNNABLE);
    await pg.exec(RUNNABLE);
    const passages = getTableConfig(documentPassages);
    expect(await columnsOf(pg, "document_passages")).toEqual(
      passages.columns.map((c) => c.name).sort()
    );
    expect(await columnsOf(pg, "document_passage_state")).toEqual(
      getTableConfig(documentPassageState)
        .columns.map((c) => c.name)
        .sort()
    );
    const declared = passages.indexes.map((i) => i.config.name!);
    expect(declared).toEqual(["uq_document_passages_document_ordinal"]);
    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'document_passages'`
    );
    expect(idx.rows.map((r) => r.indexname)).toContain(declared[0]);
    await pg.close();
  }, 60_000);

  it("one passage per (document, ordinal); a deleted document takes its passages and state", async () => {
    const pg = new PGlite();
    await pg.exec(DOCUMENTS_STUB);
    await pg.exec(RUNNABLE);
    const doc = randomUUID();
    await pg.query(`INSERT INTO documents VALUES ($1)`, [doc]);
    const ins = (ordinal: number) =>
      pg.query(
        `INSERT INTO document_passages (document_id, ordinal, section_id, char_start, char_end, text, text_hash, source_revision, embedding)
         VALUES ($1, $2, 's', 0, 1, 't', 'h', 1, '[0]')`,
        [doc, ordinal]
      );
    await ins(0);
    await ins(1);
    await expect(ins(0)).rejects.toThrow(/duplicate key/);
    await pg.query(
      `INSERT INTO document_passage_state (document_id, source_revision, passage_count) VALUES ($1, 1, 2)`,
      [doc]
    );
    await pg.query(`DELETE FROM documents WHERE id = $1`, [doc]);
    expect(
      (await pg.query(`SELECT 1 FROM document_passages`)).rows
    ).toHaveLength(0);
    expect(
      (await pg.query(`SELECT 1 FROM document_passage_state`)).rows
    ).toHaveLength(0);
    await pg.close();
  }, 60_000);

  it("the baseline carries the same tables + indexes, and schema-coherence names them", () => {
    expect(M0358).toContain(HNSW);
    const body = M0358.slice(
      M0358.indexOf('CREATE TABLE IF NOT EXISTS "document_passages"')
    );
    expect(body.length).toBeGreaterThan(1_000);
    expect(BASELINE).toContain(body.trim());
    for (const table of ["document_passages", "document_passage_state"]) {
      expect(
        REQUIRED_COLUMNS.filter((c) => c.table === table).every(
          (c) => c.addedBy === "0358b_document_passages.sql"
        )
      ).toBe(true);
      expect(REQUIRED_COLUMNS.some((c) => c.table === table)).toBe(true);
    }
  });
});

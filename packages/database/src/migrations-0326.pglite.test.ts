/**
 * REAL-POSTGRES (PGlite) test for migration 0326 — stored Knowledge
 * `knowledgeForm = 'insight'` becomes `'fact'` (plan 9992207a §5):
 *   - only Knowledge rows holding `insight` change; every other key on the row
 *     (notably the legacy `ek_type`) is kept as stored;
 *   - caution / convention rows and a non-knowledge row that happens to carry
 *     the same key are untouched;
 *   - a second run changes nothing (idempotent).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0326 = readFileSync(
  resolve(HERE, "../migrations/0326_knowledge_form_insight_to_fact.sql"),
  "utf8"
);

let pg: PGlite;

async function rows() {
  const r = await pg.query<{ id: string; properties: Record<string, unknown> }>(
    "SELECT id, properties FROM entities ORDER BY id"
  );
  return Object.fromEntries(r.rows.map((x) => [x.id, x.properties]));
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE entities (
      id text PRIMARY KEY, type text NOT NULL,
      properties jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT '2026-01-01'
    );
    INSERT INTO entities (id, type, properties) VALUES
      ('k1', 'knowledge', '{"knowledgeForm":"insight","ek_type":"lesson","ek_claim":"A"}'),
      ('k2', 'knowledge', '{"knowledgeForm":"insight"}'),
      ('k3', 'knowledge', '{"knowledgeForm":"caution","ek_type":"gotcha"}'),
      ('k4', 'knowledge', '{"knowledgeForm":"convention"}'),
      ('k5', 'knowledge', '{"ek_type":"reference"}'),
      ('n1', 'note',      '{"knowledgeForm":"insight"}');
  `);
}, 120_000);
afterAll(async () => pg?.close());

describe("migration 0326 — knowledgeForm insight → fact", () => {
  it("rewrites only Knowledge insight rows and keeps every other key", async () => {
    await pg.exec(M0326);
    const r = await rows();
    expect(r.k1).toEqual({
      knowledgeForm: "fact",
      ek_type: "lesson",
      ek_claim: "A",
    });
    expect(r.k2).toEqual({ knowledgeForm: "fact" });
    expect(r.k3).toEqual({ knowledgeForm: "caution", ek_type: "gotcha" });
    expect(r.k4).toEqual({ knowledgeForm: "convention" });
    expect(r.k5).toEqual({ ek_type: "reference" });
    expect(r.n1).toEqual({ knowledgeForm: "insight" });
    const touched = await pg.query<{ id: string }>(
      "SELECT id FROM entities WHERE updated_at > '2026-01-01' ORDER BY id"
    );
    expect(touched.rows.map((x) => x.id)).toEqual(["k1", "k2"]);
  });

  it("is idempotent: a re-run finds nothing to change", async () => {
    const before = await rows();
    const res = await pg.query(
      M0326.replace(/--[^\n]*\n/g, "")
        .trim()
        .replace(/;$/, "")
    );
    expect(res.affectedRows).toBe(0);
    expect(await rows()).toEqual(before);
  });
});

/**
 * REAL-POSTGRES (PGlite) test for migration 0374 — the hold-read indexes on
 * the transition outbox (status-flow W4). The migration applies on top of
 * 0324 and again as a no-op; the baseline carries the same statements; and
 * the planner can serve `listHolds`'s "which holds wait on this thing?" from
 * the partial index (the reason the index exists).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0324 = read("0324_lifecycle_transition_outbox.sql");
const M0374 = read("0374_lifecycle_transition_outbox_hold_indexes.sql");
const BASELINE = read("0000_baseline_schema.sql");

const statements = (sql: string) =>
  sql
    .split(";")
    .map((s) => s.replace(/--[^\n]*\n/g, "").trim())
    .filter((s) => s.startsWith("CREATE INDEX"));

describe("migration 0374 — hold-read indexes", () => {
  it("creates both indexes, idempotently", async () => {
    const pg = new PGlite();
    await pg.exec(M0324);
    await pg.exec(M0374);
    await pg.exec(M0374);
    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'lifecycle_transition_outbox'`
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        "lifecycle_transition_outbox_hold_moves_idx",
        "lifecycle_transition_outbox_subject_idx",
      ])
    );
    // The awaited-thing read can use the partial index.
    await pg.exec(`SET enable_seqscan = off`);
    const plan = await pg.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT transition FROM lifecycle_transition_outbox o
        WHERE o.transition->'hold'->'until'->>'moves' = 'entity:e1'`
    );
    expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain(
      "lifecycle_transition_outbox_hold_moves_idx"
    );
    await pg.close();
  }, 60_000);

  it("the baseline carries the same indexes", () => {
    const found = statements(M0374);
    expect(found).toHaveLength(2);
    for (const s of found) expect(BASELINE).toContain(s);
  });
});

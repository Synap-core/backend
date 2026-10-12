/**
 * REAL-POSTGRES (PGlite) test for migration 0323 — the work model's read-cost
 * indexes (review 2026-10-12, backend F3/F4/F13):
 *   - `(profile_id, status)` on entities and entity_facets, for the board /
 *     lifecycle.list group-by-value read;
 *   - `focus_sessions((metadata->>'automationId'))`, for the worker reads.
 * Pins the PLAN before and after on each read shape, and that the baseline
 * carries the same three indexes (a fresh pod never runs 0323 itself).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0323 = readFileSync(
  resolve(
    HERE,
    "../migrations/0323_lifecycle_status_and_worker_session_indexes.sql"
  ),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);
const CREATES = [
  `CREATE INDEX IF NOT EXISTS "entities_profile_status_idx"`,
  `CREATE INDEX IF NOT EXISTS "entity_facets_profile_status_idx"`,
  `CREATE INDEX IF NOT EXISTS idx_focus_sessions_automation_id`,
];

const BOARD = (table: string) => `EXPLAIN SELECT status, count(*) FROM ${table}
  WHERE profile_id = '00000000-0000-0000-0000-000000000007'
    AND status = 'won' AND deleted_at IS NULL GROUP BY status`;
const WORKER = `EXPLAIN SELECT id FROM focus_sessions
  WHERE metadata->>'automationId' = 'auto-7'`;

let pg: PGlite;

async function plan(query: string): Promise<string> {
  const r = await pg.query<{ "QUERY PLAN": string }>(query);
  return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      profile_id uuid, status text, deleted_at timestamptz
    );
    CREATE TABLE entity_facets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      profile_id uuid, status text, deleted_at timestamptz
    );
    CREATE TABLE focus_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    -- 50 profiles, 8 statuses each; one in 20 sessions was opened by a rule.
    INSERT INTO entities (profile_id, status)
      SELECT ('00000000-0000-0000-0000-0000000000' || lpad((g % 50)::text, 2, '0'))::uuid,
             (ARRAY['draft','proposed','negotiating','won','lost','a','b','c'])[1 + g % 8]
        FROM generate_series(1, 20000) g;
    INSERT INTO entity_facets (profile_id, status) SELECT profile_id, status FROM entities;
    INSERT INTO focus_sessions (metadata)
      SELECT CASE WHEN g % 20 = 0
                  THEN jsonb_build_object('automationId', 'auto-' || (g % 300))
                  ELSE '{}'::jsonb END
        FROM generate_series(1, 20000) g;
    ANALYZE entities; ANALYZE entity_facets; ANALYZE focus_sessions;
  `);
}, 120_000);

describe("migration 0323 — status + worker-session indexes", () => {
  it("before: each read scans its table", async () => {
    expect(await plan(BOARD("entities"))).toMatch(/Seq Scan on entities/);
    expect(await plan(BOARD("entity_facets"))).toMatch(
      /Seq Scan on entity_facets/
    );
    expect(await plan(WORKER)).toMatch(/Seq Scan on focus_sessions/);
  });

  it("after: each read probes its index; re-running is a no-op", async () => {
    await pg.exec(M0323);
    await pg.exec(M0323); // idempotent
    await pg.exec(
      "ANALYZE entities; ANALYZE entity_facets; ANALYZE focus_sessions;"
    );
    const uses = (name: string) =>
      new RegExp(
        `Index (Only )?Scan using ${name}|Bitmap Index Scan on ${name}`
      );
    expect(await plan(BOARD("entities"))).toMatch(
      uses("entities_profile_status_idx")
    );
    expect(await plan(BOARD("entity_facets"))).toMatch(
      uses("entity_facets_profile_status_idx")
    );
    expect(await plan(WORKER)).toMatch(
      uses("idx_focus_sessions_automation_id")
    );
  });

  it("the baseline creates the same three indexes", () => {
    for (const create of CREATES) {
      expect(M0323).toContain(create);
      expect(BASELINE).toContain(create);
    }
  });
});

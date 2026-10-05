/**
 * REAL-POSTGRES (PGlite) test for migration 0303 — a partial expression index
 * on `focus_sessions(metadata->>'automationRunId')`.
 *
 * The lens page's rule-run Happening read (`signals.ts` readRuleRuns, on every
 * Home read) keeps a run only when NO session carries its id:
 *   NOT EXISTS (SELECT 1 FROM focus_sessions fs
 *               WHERE fs.metadata->>'automationRunId' = r.id::text)
 * Before 0303 nothing indexed that expression, so the anti-join scanned
 * focus_sessions. This pins the PLAN, before and after, on that exact shape —
 * and proves the partial predicate (`IS NOT NULL`) is one the planner can
 * prove from the strict `=`, so the index is actually usable.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0303 = readFileSync(
  resolve(
    HERE,
    "../migrations/0303_focus_sessions_automation_run_id_index.sql"
  ),
  "utf8"
);

/** The rule-run read's anti-join, per run (a handful of recent runs). */
const RULE_RUN_ANTI_JOIN = `EXPLAIN SELECT r.id FROM automation_runs r
  WHERE r.started_at > now() - interval '1 hour'
    AND NOT EXISTS (
      SELECT 1 FROM focus_sessions fs
       WHERE fs.metadata->>'automationRunId' = r.id::text
    )`;

let pg: PGlite;

async function plan(): Promise<string> {
  const r = await pg.query<{ "QUERY PLAN": string }>(RULE_RUN_ANTI_JOIN);
  return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE focus_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE automation_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      started_at timestamptz NOT NULL
    );
    CREATE INDEX automation_runs_started ON automation_runs (started_at);
    -- A realistic pod: most sessions are not runs; one in 25 was opened by one.
    INSERT INTO focus_sessions (user_id, metadata)
      SELECT 'u', CASE WHEN g % 25 = 0
                       THEN jsonb_build_object('automationRunId', gen_random_uuid()::text)
                       ELSE '{}'::jsonb END
        FROM generate_series(1, 20000) g;
    -- Many old runs, a few recent ones.
    INSERT INTO automation_runs (started_at)
      SELECT now() - (g || ' hours')::interval FROM generate_series(2, 5000) g;
    INSERT INTO automation_runs (started_at)
      SELECT now() - interval '5 minutes' FROM generate_series(1, 5);
    ANALYZE focus_sessions;
    ANALYZE automation_runs;
  `);
}, 120_000);

describe("migration 0303 — focus_sessions(metadata->>'automationRunId')", () => {
  it("before: the anti-join scans focus_sessions", async () => {
    const before = await plan();
    expect(before).toMatch(/Seq Scan on focus_sessions/);
  });

  it("after: the anti-join probes idx_focus_sessions_automation_run_id; re-running is a no-op", async () => {
    await pg.exec(M0303);
    await pg.exec(M0303); // idempotent
    await pg.exec("ANALYZE focus_sessions;");
    const after = await plan();
    expect(after).toMatch(
      /Index (Only )?Scan using idx_focus_sessions_automation_run_id|Bitmap Index Scan on idx_focus_sessions_automation_run_id/
    );
    expect(after).not.toMatch(/Seq Scan on focus_sessions/);
    const idx = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_focus_sessions_automation_run_id'`
    );
    expect(idx.rows).toHaveLength(1);
  });

  it("the index is honest: a run with a session is still found, one without is kept", async () => {
    const [{ id: withSession }] = (
      await pg.query<{ id: string }>(
        `INSERT INTO automation_runs (started_at) VALUES (now()) RETURNING id`
      )
    ).rows;
    await pg.query(
      `INSERT INTO focus_sessions (user_id, metadata) VALUES ('u', jsonb_build_object('automationRunId', $1::text))`,
      [withSession]
    );
    const kept = await pg.query<{ id: string }>(
      `SELECT r.id FROM automation_runs r
        WHERE r.started_at > now() - interval '1 hour'
          AND NOT EXISTS (SELECT 1 FROM focus_sessions fs
                           WHERE fs.metadata->>'automationRunId' = r.id::text)`
    );
    const ids = kept.rows.map((r) => r.id);
    expect(ids).not.toContain(withSession);
    expect(ids.length).toBe(5);
  });
});

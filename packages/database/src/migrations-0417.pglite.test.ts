/**
 * REAL-POSTGRES (PGlite) test for migration 0417 — a one-shot (generate) run's
 * record on its run row (plan 08e4fba7 slice 1):
 *   - `playbook_runs.generation` is added idempotently, NULL on every run that
 *     existed before it (no run before 0417 was a generate run);
 *   - a run is found by (playbook, subject) through its record, the lookup the
 *     idempotency and cooldown checks make;
 *   - the baseline carries the same lines; the boot coherence list names them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const FILE = "0417_playbook_runs_generation.sql";
const M0417 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");
const PB = "33333333-3333-4333-8333-333333333333";
const SUBJECT = "44444444-4444-4444-8444-444444444444";

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  // A run ledger as it stood before 0417.
  await pg.exec(`
    CREATE TABLE "playbook_runs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "playbook_id" uuid NOT NULL,
      "session_id" uuid,
      "executor" text NOT NULL,
      "status" text NOT NULL DEFAULT 'running',
      "started_at" timestamptz NOT NULL DEFAULT now(),
      "created_by" text NOT NULL
    );
    INSERT INTO "playbook_runs" ("playbook_id", "executor", "created_by")
    VALUES ('${PB}', 'is-agent', 'u-1');
  `);
  await pg.exec(M0417);
  await pg.exec(M0417);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0417 — a one-shot run's record", () => {
  it("an existing run carries no record", async () => {
    const { rows } = await pg.query<{ generation: unknown }>(
      `SELECT generation FROM playbook_runs`
    );
    expect(rows).toEqual([{ generation: null }]);
  });

  it("a generate run is found by (playbook, subject) through its record", async () => {
    await pg.query(
      `INSERT INTO playbook_runs (playbook_id, executor, status, created_by, generation)
       VALUES ($1, 'generate', 'proposed', 'u-1', $2::jsonb)`,
      [PB, JSON.stringify({ subjectId: SUBJECT, model: null })]
    );
    const { rows } = await pg.query<{ executor: string; session_id: null }>(
      `SELECT executor, session_id FROM playbook_runs
        WHERE playbook_id = $1 AND generation->>'subjectId' = $2`,
      [PB, SUBJECT]
    );
    expect(rows).toEqual([{ executor: "generate", session_id: null }]);
  });

  it("the baseline carries the same lines and the boot check names the column", () => {
    for (const line of [
      'ALTER TABLE "playbook_runs" ADD COLUMN IF NOT EXISTS "generation" jsonb;',
      'CREATE INDEX IF NOT EXISTS "idx_playbook_runs_generation_subject"',
    ]) {
      expect(M0417).toContain(line);
      expect(BASELINE).toContain(line);
    }
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "playbook_runs",
        column: "generation",
        addedBy: FILE,
      })
    );
  });
});

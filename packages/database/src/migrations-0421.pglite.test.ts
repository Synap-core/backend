/**
 * REAL-POSTGRES (PGlite) test for migration 0421 — a `forEach` step's
 * batches and child runs on its step row (`session_stage_runs.fan_out`):
 *   - the column is added idempotently on top of 0417 and holds jsonb;
 *   - the baseline carries the same line; the boot coherence list names it.
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
const FILE = "0421_session_stage_runs_fan_out.sql";
const M0421 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(read("0417_session_stage_runs.sql"));
  await pg.exec(M0421);
  await pg.exec(M0421);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0421 — a forEach step's fan-out", () => {
  it("adds fan_out idempotently, as jsonb", async () => {
    await pg.query(
      `INSERT INTO session_stage_runs (session_id, stage_key, runner_via, fan_out)
       VALUES (gen_random_uuid(), 'review', 'self', '{"batch":30,"children":[]}'::jsonb)`
    );
    const { rows } = await pg.query<{ batch: number }>(
      `SELECT (fan_out ->> 'batch')::int AS batch FROM session_stage_runs`
    );
    expect(rows).toEqual([{ batch: 30 }]);
  });

  it("the baseline carries the same line and the boot check names it", () => {
    const line =
      'ALTER TABLE "session_stage_runs" ADD COLUMN IF NOT EXISTS "fan_out" jsonb;';
    expect(M0421).toContain(line);
    expect(BASELINE).toContain(line);
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "session_stage_runs",
        column: "fan_out",
        addedBy: FILE,
      })
    );
  });
});

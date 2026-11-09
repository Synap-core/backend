/**
 * REAL-POSTGRES (PGlite) test for migration 0417 — one row per step entry
 * of a playbook run (`session_stage_runs`, runner engine slice 3):
 *   - the table is created idempotently, with its defaults (status
 *     `running`, attempt 1, started now) and the (session, stage) index;
 *   - the baseline carries the same lines; the boot coherence list names it.
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
const FILE = "0417_session_stage_runs.sql";
const M0417 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(M0417);
  await pg.exec(M0417);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0417 — who works each step of a run", () => {
  it("creates the table idempotently, with its defaults", async () => {
    await pg.query(
      `INSERT INTO session_stage_runs (session_id, stage_key, runner_via)
       VALUES (gen_random_uuid(), 'render', 'self')`
    );
    const { rows } = await pg.query<{
      status: string;
      attempt: number;
      started: boolean;
    }>(
      `SELECT status, attempt, started_at IS NOT NULL AS started FROM session_stage_runs`
    );
    expect(rows).toEqual([{ status: "running", attempt: 1, started: true }]);
    await expect(
      pg.query(
        `INSERT INTO session_stage_runs (session_id, stage_key) VALUES (gen_random_uuid(), 'x')`
      )
    ).rejects.toThrow();
    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'session_stage_runs'`
    );
    expect(idx.rows.map((r) => r.indexname)).toContain(
      "session_stage_runs_session_stage_idx"
    );
  });

  it("the baseline carries the same table and the boot check names it", () => {
    for (const line of [
      'CREATE TABLE IF NOT EXISTS "session_stage_runs" (',
      '"runner_via"           text        NOT NULL,',
      'CREATE INDEX IF NOT EXISTS "session_stage_runs_session_stage_idx"',
    ]) {
      expect(M0417).toContain(line);
      expect(BASELINE).toContain(line);
    }
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "session_stage_runs",
        column: "runner_via",
        addedBy: FILE,
      })
    );
  });
});

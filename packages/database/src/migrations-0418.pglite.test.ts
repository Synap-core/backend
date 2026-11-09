/**
 * REAL-POSTGRES (PGlite) test for migration 0418 — who did an automation step
 * (runner engine slice 5): `automation_step_runs` gains `agent_user_id`,
 * `computer_user_id` and `child_session_id` (+ a partial index on the last),
 * idempotently; the baseline carries the same lines; the boot coherence list
 * names it.
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
const FILE = "0418_automation_step_run_who.sql";
const M0418 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  // The table as it stood before 0418.
  await pg.exec(
    `CREATE TABLE automation_step_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid, node_id text, output jsonb DEFAULT '{}')`
  );
  await pg.exec(M0418);
  await pg.exec(M0418);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0418 — who did an automation step", () => {
  it("adds the three columns and the index, idempotently", async () => {
    const child = "11111111-1111-4111-8111-111111111111";
    await pg.query(
      `INSERT INTO automation_step_runs (node_id, agent_user_id, computer_user_id, child_session_id)
       VALUES ('run', 'agent-1', 'mac-1', $1)`,
      [child]
    );
    const { rows } = await pg.query(
      `SELECT agent_user_id, computer_user_id, child_session_id FROM automation_step_runs`
    );
    expect(rows).toEqual([
      {
        agent_user_id: "agent-1",
        computer_user_id: "mac-1",
        child_session_id: child,
      },
    ]);
    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'automation_step_runs'`
    );
    expect(idx.rows.map((r) => r.indexname)).toContain(
      "automation_step_runs_child_session_idx"
    );
  });

  it("the baseline carries the same lines and the boot check names it", () => {
    for (const line of [
      'ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "agent_user_id" text;',
      'ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "computer_user_id" text;',
      'ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "child_session_id" uuid;',
      'CREATE INDEX IF NOT EXISTS "automation_step_runs_child_session_idx"',
    ]) {
      expect(M0418).toContain(line);
      expect(BASELINE).toContain(line);
    }
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "automation_step_runs",
        column: "child_session_id",
        addedBy: FILE,
      })
    );
  });
});

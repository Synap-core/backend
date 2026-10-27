/**
 * REAL-POSTGRES (PGlite) test for migration 0356 — box runs. The migration and
 * the baseline create `box_runs` with EVERY column and index the drizzle
 * schema declares, schema-coherence names it, re-running is a no-op, the
 * status CHECK refuses a state the lease protocol does not know (`stalled` is
 * a READ verdict, never stored), and deleting a skill keeps its runs' history.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { boxRuns, BOX_RUN_STATUSES } from "./schema/box-runs.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0356 = readFileSync(
  resolve(HERE, "../migrations/0356_box_runs.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);
const cfg = getTableConfig(boxRuns);
const declaredColumns = cfg.columns.map((c) => c.name);
const declaredIndexes = cfg.indexes.map((i) => i.config.name!);

const SKILLS_STUB = `CREATE TABLE skills (id uuid PRIMARY KEY)`;
const SPEC = `'{"name":"s","language":"python","entrypoint":"main.py","code":"print(1)","packages":[],"hosts":[],"limits":{"wallSeconds":900,"cpus":2,"memoryMb":2048,"diskMb":8192,"outMb":200}}'`;

describe("migration 0356 — box_runs", () => {
  it("creates every declared column and index, idempotently", async () => {
    const pg = new PGlite();
    await pg.exec(SKILLS_STUB);
    await pg.exec(M0356);
    await pg.exec(M0356);
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'box_runs'`
    );
    expect(declaredColumns.length).toBe(24);
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      [...declaredColumns].sort()
    );
    expect(declaredIndexes.sort()).toEqual([
      "idx_box_runs_queue",
      "idx_box_runs_session",
      "idx_box_runs_skill",
      "idx_box_runs_user_queued",
    ]);
    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'box_runs'`
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(declaredIndexes)
    );
    await pg.close();
  }, 60_000);

  it("stores only the protocol's states; a deleted skill keeps the run", async () => {
    const pg = new PGlite();
    await pg.exec(SKILLS_STUB);
    await pg.exec(M0356);
    const skill = randomUUID();
    await pg.query(`INSERT INTO skills VALUES ($1)`, [skill]);
    for (const status of BOX_RUN_STATUSES) {
      await pg.query(
        `INSERT INTO box_runs (skill_id, user_id, spec, status) VALUES ($1, 'u', ${SPEC}::jsonb, $2)`,
        [skill, status]
      );
    }
    await expect(
      pg.query(
        `INSERT INTO box_runs (user_id, spec, status) VALUES ('u', ${SPEC}::jsonb, 'stalled')`
      )
    ).rejects.toThrow(/box_runs_status_check/);
    await pg.query(`DELETE FROM skills WHERE id = $1`, [skill]);
    const left = await pg.query<{ skill_id: string | null }>(
      `SELECT skill_id FROM box_runs`
    );
    expect(left.rows).toHaveLength(BOX_RUN_STATUSES.length);
    expect(left.rows.every((r) => r.skill_id === null)).toBe(true);
    await pg.close();
  }, 60_000);

  it("the baseline carries the same table + indexes, and schema-coherence names it", () => {
    const start = M0356.indexOf('CREATE TABLE IF NOT EXISTS "box_runs"');
    const create = M0356.slice(start, M0356.indexOf(");", start) + 2);
    expect(create.length).toBeGreaterThan(500);
    expect(BASELINE).toContain(create.trim());
    for (const name of declaredIndexes) expect(BASELINE).toContain(`"${name}"`);
    expect(BASELINE).toContain('"box_runs_status_check"');
    expect(
      REQUIRED_COLUMNS.filter((c) => c.table === "box_runs").map(
        (c) => c.column
      )
    ).toEqual(expect.arrayContaining(["lease_id", "evidence"]));
  });
});

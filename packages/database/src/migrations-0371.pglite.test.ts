/**
 * REAL-POSTGRES (PGlite) test for migration 0371 — the one-off
 * `automations.run_count` backfill (run_count = success_count + failure_count):
 *  - a doubled pre-fix row is corrected;
 *  - a row that already agrees, and a never-run row, are untouched;
 *  - NULL counters are read as 0;
 *  - idempotent (applied twice).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../migrations/0371_automation_run_count_backfill.sql"),
  "utf8"
);

let pg: PGlite;

const counts = async (name: string) => {
  const r = await pg.query<{ run: number | null; ok: number | null; bad: number | null }>(
    `SELECT run_count AS run, success_count AS ok, failure_count AS bad FROM automations WHERE name = $1`,
    [name]
  );
  return r.rows[0]!;
};

beforeAll(async () => {
  pg = new PGlite();
  // The columns of the real table are NOT NULL DEFAULT 0; this fixture is
  // nullable so the COALESCE guard is exercised too.
  await pg.exec(`
    CREATE TABLE automations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text,
      run_count integer DEFAULT 0,
      success_count integer DEFAULT 0,
      failure_count integer DEFAULT 0
    );
    INSERT INTO automations (name, run_count, success_count, failure_count) VALUES
      ('doubled', 142, 70, 1),
      ('correct', 5, 4, 1),
      ('skipped-only', 0, 0, 0),
      ('null-counters', 4, NULL, 2);
  `);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

describe("0371 automations.run_count backfill", () => {
  it("corrects a doubled pre-fix row to success + failure", async () => {
    expect(await counts("doubled")).toEqual({ run: 71, ok: 70, bad: 1 });
  });

  it("leaves a row that already agrees untouched", async () => {
    expect(await counts("correct")).toEqual({ run: 5, ok: 4, bad: 1 });
    expect(await counts("skipped-only")).toEqual({ run: 0, ok: 0, bad: 0 });
  });

  it("reads a NULL counter as 0", async () => {
    expect(await counts("null-counters")).toEqual({ run: 2, ok: null, bad: 2 });
  });
});

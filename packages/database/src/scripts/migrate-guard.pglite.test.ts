/**
 * REAL-POSTGRES (PGlite) test for the migration runner's populated-database
 * guard (`scripts/migrate.ts` → `planMigrations`).
 *
 * 2026-10-05: a desynchronised connection made the runner read `_migrations`
 * as missing + empty on a populated pod and re-apply the baseline and every
 * later migration over live data. The runner must now:
 *   - fresh DB                                   → apply everything (baseline first)
 *   - populated DB, `_migrations` missing/empty  → REFUSE
 *   - `_migrations` read error                   → ABORT (never "empty")
 *   - a read answered with another query's rows  → ABORT
 *   - populated DB with history                  → apply only what is pending
 *
 * Not covered here: the runner loop itself (applyMigration, exit codes) — it
 * needs a postgres.js socket; this drives the decision it consumes.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";

process.env.SYNAP_MIGRATE_IMPORT_ONLY = "1";
const { planMigrations, MigrationRefusal } = await import("./migrate.js");

const FILES = ["0000_baseline_schema.sql", "0001_first.sql", "0002_second.sql"];

let pg: PGlite;
const q = (text: string) =>
  pg.query<Record<string, unknown>>(text).then((r) => r.rows);

const CORE = `
  CREATE TABLE users (id text PRIMARY KEY);
  CREATE TABLE workspaces (id text PRIMARY KEY);
  CREATE TABLE entities (id text PRIMARY KEY);
`;
const HISTORY = `CREATE TABLE _migrations (
  id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

beforeAll(() => {
  // One PGlite boot per test is the flaky pattern vitest.unit.config.ts warns
  // about; reset the schema instead.
  pg = new PGlite();
});
beforeEach(async () => {
  await pg.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
});

describe("migration runner guard — populated database", () => {
  it("fresh DB (no core tables, empty history) → every migration pending, baseline first", async () => {
    await pg.exec(HISTORY);
    const { applied, pending } = await planMigrations(q, FILES);
    expect(applied.size).toBe(0);
    expect(pending).toEqual(FILES);
  });

  it("fresh DB whose _migrations does not exist yet reads as a FAILED read, not empty", async () => {
    // The runner always creates _migrations first (initMigrationsTable); a
    // missing table at read time means something went wrong — abort.
    await expect(planMigrations(q, FILES)).rejects.toThrow(MigrationRefusal);
    await expect(planMigrations(q, FILES)).rejects.toThrow(
      /Could not read _migrations/
    );
  });

  it("populated DB + EMPTY _migrations → refuses, naming the tables and the recovery path", async () => {
    await pg.exec(CORE + HISTORY + `INSERT INTO entities VALUES ('e1');`);
    const err = await planMigrations(q, FILES).catch((e) => e);
    expect(err).toBeInstanceOf(MigrationRefusal);
    expect(err.exitCode).not.toBe(0);
    expect(err.message).toMatch(
      /_migrations is empty, but the database is POPULATED/
    );
    expect(err.message).toMatch(/rows in: entities/);
    expect(err.message).toMatch(/Recovery \(manual\)/);
  });

  it("populated DB + _migrations re-created empty by the runner (was missing) → refuses", async () => {
    // initMigrationsTable's CREATE TABLE IF NOT EXISTS runs first when the
    // table reads missing, so "missing" reaches the guard as "empty".
    await pg.exec(CORE + `INSERT INTO users VALUES ('u1');` + HISTORY);
    await expect(planMigrations(q, FILES)).rejects.toThrow(/rows in: users/);
  });

  it("core tables exist but hold NO rows + empty history → applies (nothing to lose)", async () => {
    await pg.exec(CORE + HISTORY);
    const { pending } = await planMigrations(q, FILES);
    expect(pending).toEqual(FILES);
  });

  it("_migrations read ERROR → aborts, never treated as empty", async () => {
    // A _migrations table with no filename column: the read itself errors.
    await pg.exec(`CREATE TABLE _migrations (id int);`);
    const err = await planMigrations(q, FILES).catch((e) => e);
    expect(err).toBeInstanceOf(MigrationRefusal);
    expect(err.message).toMatch(
      /Could not read _migrations.*not an empty history/s
    );
  });

  it("a read answered with ANOTHER query's result (desynchronised connection) → aborts", async () => {
    await pg.exec(CORE + HISTORY + `INSERT INTO entities VALUES ('e1');`);
    // Simulate the 2026-10-05 shift: every answer is the previous query's.
    let previous: ReadonlyArray<Record<string, unknown>> = [];
    const shifted = async (text: string) => {
      const out = previous;
      previous = await q(text);
      return out;
    };
    await q(`SELECT 'some-earlier-query' AS probe`).then((r) => (previous = r));
    await expect(planMigrations(shifted, FILES)).rejects.toThrow(
      /desynchronised/
    );
  });

  it("populated DB WITH history → applies only what is pending", async () => {
    await pg.exec(
      CORE +
        HISTORY +
        `INSERT INTO entities VALUES ('e1');
         INSERT INTO _migrations (filename) VALUES ('0000_baseline_schema.sql'), ('0001_first.sql');`
    );
    const { applied, pending } = await planMigrations(q, FILES);
    expect([...applied].sort()).toEqual([
      "0000_baseline_schema.sql",
      "0001_first.sql",
    ]);
    expect(pending).toEqual(["0002_second.sql"]);
  });
});

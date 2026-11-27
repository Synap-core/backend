/**
 * `notAutomationSessionWhere` (the agent doors' default population, decision
 * 90897bca) and the partial index 0462 that serves it, on a real Postgres
 * planner (PGlite).
 *
 * 1. THE PREDICATE, executed against the TypeScript derivation: over every
 *    session-kind fixture it leaves out exactly the rows an automation opened
 *    that read `run` (origin `automation` or an automation key, not accepted
 *    from triage, not scheduled), and keeps every other row, NULL origin and
 *    NULL metadata included.
 * 2. THE INDEX: Postgres uses a partial index only when the query's WHERE
 *    carries its predicate. The query here is the clause the doors render
 *    (`PgDialect` over the real function), so this proves the rendered text
 *    and the migration's text are the same expression to the planner: with
 *    0462 the newest page is one descent of the index (no Sort, no automation
 *    row read); before it, every one of the person's rows is read and sorted.
 *    The predicate renders with NO bind parameter (only the user id is one): a
 *    `$1` for `'automation'` is planned as a constant here (a custom plan) but
 *    not under a generic plan, so the planner here would not catch it; the
 *    params assertion does.
 * 3. The drizzle schema declares the same predicate the migration creates.
 *
 * Cannot see: production plans (measured on the founder's pod before the
 * change: the founder's default list read 14,761 rows to return 20, 17-23 ms;
 * the automation agent's 49,390 rows for 42, 50 ms), the doors themselves
 * (`agent-doors-no-automation.pglite.test.ts`).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { and, eq, focusSessions } from "@synap/database";
import type { SQL } from "@synap/database";
import {
  notAutomationSessionWhere,
  projectSessionKind,
  startedByAutomation,
} from "./session-kind.js";
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import { FIXTURES } from "./__tests__/session-kind.fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0462 = readFileSync(
  resolve(
    HERE,
    "../../../../database/migrations/0462_focus_sessions_not_automation_index.sql"
  ),
  "utf8"
);
const INDEX = "idx_focus_sessions_user_started_not_automation";

const dialect = new PgDialect();
const pg = new PGlite();
const q = async <T>(sql: string, params?: unknown[]) =>
  (await pg.query<T>(sql, params)) as { rows: T[] };

/** The doors' clause for one person, rendered as the doors render it. */
function rendered(userId: string): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(
    and(eq(focusSessions.userId, userId), notAutomationSessionWhere()) as SQL
  );
}

/** The page query with its one parameter (the user id) inlined, for EXPLAIN. */
function pageQuery(userId: string): string {
  const { sql, params } = rendered(userId);
  expect(params).toEqual([userId]);
  return `SELECT id FROM focus_sessions WHERE ${sql.replace("$1", `'${userId}'`)}
          ORDER BY started_at DESC, id DESC LIMIT 21`;
}

async function plan(userId: string): Promise<string> {
  const r = await q<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${pageQuery(userId)}`
  );
  return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

function removedByFilter(text: string): number {
  return [...text.matchAll(/Rows Removed by Filter: (\d+)/g)].reduce(
    (n, m) => n + Number(m[1]),
    0
  );
}

// ── Rows ───────────────────────────────────────────────────────────────────

const FIX_USER = "u-fixtures";
const fixtureRows = FIXTURES.map((f) => ({ ...f, id: randomUUID() }));

const BUSY = "u-busy";
const AUTOMATION_ROWS = 12_000;
const PERSON_ROWS = 200;

beforeAll(async () => {
  await pg.exec(pgliteTableDdl(focusSessions as unknown as PgTable));
  // The index every list read used before 0462.
  await pg.exec(
    `CREATE INDEX idx_focus_sessions_user_id ON focus_sessions (user_id);`
  );
  for (const r of fixtureRows) {
    await q(
      `insert into focus_sessions (id, user_id, goal, status, origin, playbook_id, metadata, started_at)
       values ($1, $2, 'g', $3, $4, $5, $6::jsonb, now())`,
      [
        r.id,
        FIX_USER,
        r.row.status,
        r.row.origin ?? null,
        r.row.playbookId ? randomUUID() : null,
        r.row.metadata == null ? null : JSON.stringify(r.row.metadata),
      ]
    );
  }
  // A busy person: automation runs interleaved in time with their own work,
  // the newest rows automation (as on the pod: one run per webhook).
  await pg.exec(`
    INSERT INTO focus_sessions (id, user_id, goal, status, origin, metadata, started_at)
      SELECT gen_random_uuid(), '${BUSY}', 'g', 'closed', 'automation',
             jsonb_build_object('automationRunId', gen_random_uuid()::text),
             now() - make_interval(secs => g)
        FROM generate_series(1, ${AUTOMATION_ROWS}) g;
    INSERT INTO focus_sessions (id, user_id, goal, status, origin, metadata, started_at)
      SELECT gen_random_uuid(), '${BUSY}', 'g', 'active', 'playbook', '{}'::jsonb,
             now() - make_interval(secs => g * 60)
        FROM generate_series(1, ${PERSON_ROWS}) g;
    ANALYZE focus_sessions;
  `);
}, 120_000);

describe("notAutomationSessionWhere — the rows it keeps", () => {
  it("leaves out exactly the automation-opened `run` rows of the fixtures", async () => {
    const { sql, params } = rendered(FIX_USER);
    const kept = new Set(
      (
        await q<{ id: string }>(
          `SELECT id FROM focus_sessions WHERE ${sql}`,
          params
        )
      ).rows.map((r) => r.id)
    );
    const expected = fixtureRows.filter(
      (r) =>
        !(
          projectSessionKind(r.row) === "run" &&
          (r.row.origin === "automation" || startedByAutomation(r.row.metadata))
        )
    );
    // Non-vacuity: the fixtures hold both sides.
    expect(expected.length).toBeGreaterThan(3);
    expect(expected.length).toBeLessThan(fixtureRows.length);
    expect(kept).toEqual(new Set(expected.map((r) => r.id)));
  });
});

describe("migration 0462 — the default page through the partial index", () => {
  it("before: every row of the person is read and sorted", async () => {
    const before = await plan(BUSY);
    expect(before).not.toMatch(new RegExp(INDEX));
    expect(before).toMatch(/Sort/);
    // Every automation row of the person, plus whatever else the scan met
    // (a sequential scan also reads the fixture person's rows).
    expect(removedByFilter(before)).toBeGreaterThanOrEqual(AUTOMATION_ROWS);
  });

  it("after: one descent of the index, no automation row read; re-running is a no-op", async () => {
    await pg.exec(M0462);
    await pg.exec(M0462); // idempotent
    await pg.exec("ANALYZE focus_sessions;");
    const after = await plan(BUSY);
    expect(after).toMatch(new RegExp(`Index (Only )?Scan using ${INDEX}`));
    expect(after).not.toMatch(/Sort/);
    expect(removedByFilter(after)).toBe(0);
    // Same answer as the rows: the 21 newest of the person's own sessions.
    const page = await q<{ id: string }>(pageQuery(BUSY));
    const newest = await q<{ id: string }>(
      `SELECT id FROM focus_sessions WHERE user_id = '${BUSY}' AND origin = 'playbook'
        ORDER BY started_at DESC, id DESC LIMIT 21`
    );
    expect(page.rows.map((r) => r.id)).toEqual(newest.rows.map((r) => r.id));
  });

  it("the drizzle schema declares the predicate the migration creates", () => {
    const declared = getTableConfig(focusSessions).indexes.find(
      (i) => i.config.name === INDEX
    );
    expect(declared).toBeDefined();
    const where = dialect.sqlToQuery(declared!.config.where as SQL).sql;
    const created = M0462.match(/\n\s+WHERE (.+);\s*$/)?.[1];
    expect(created).toBeTruthy();
    expect(where.trim()).toBe(created!.trim());
  });
});

/**
 * The sweep's ended-run check joins `automation_runs` on its PRIMARY KEY as
 * a uuid (`uuidFromTextSql`), never `ar.id::text = <metadata text>`.
 *
 * Why: the text form casts the key, so each candidate session's probe was a
 * sequential scan of `automation_runs`. On the founder's pod (27 Nov 2026,
 * 63k runs, 660 MB) the candidate query ran 21 s (150 ms × 140 probes); the
 * uuid form runs 32 ms through `automation_runs_pkey`.
 *
 * Through the REAL rendered `endedRunSessionWhere()` on PGlite. Rows rule out:
 *   - the probe NOT using the primary key (the defect: `ar.id::text = …`
 *     plans a Seq Scan, so the plan assertion is what fails with it);
 *   - a bare `(… ->> 'automationRunId')::uuid` cast (the tempting fix): the
 *     malformed values below THROW under it and fail the whole sweep;
 *   - a case-insensitive pattern: an UPPERCASE id never matched `ar.id::text`
 *     (Postgres prints a uuid lowercase), so it must not match now either;
 *   - a valid id of a run that has NOT ended, or of no run, closing a session.
 * Not covered here: `run-blocked-ask.ts`'s `automationOf` uses the same
 * helper; its own PGlite suite drives that path.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql as drizzleSql, type SQL } from "drizzle-orm";

vi.mock("./complete-session.js", () => ({ completeFocusSession: vi.fn() }));
vi.mock("./session-path-sections.js", () => ({ attachNextMove: vi.fn() }));

import { uuidFromTextSql } from "@synap/database";
import { endedRunSessionWhere } from "./session-lifecycle-sweep.js";

let client: PGlite;
const dialect = new PgDialect();

async function run(sql: SQL): Promise<Array<Record<string, unknown>>> {
  const q = dialect.sqlToQuery(sql);
  return (await client.query<Record<string, unknown>>(q.sql, q.params)).rows;
}

const ENDED_RUN = randomUUID();
const RUNNING_RUN = randomUUID();

/** A run session (origin automation) pointing at `runId` as written. */
async function runSession(runId: unknown): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into focus_sessions (id, user_id, status, origin, metadata, expected_outputs, channel_id, updated_at)
     values ($1, $2, 'active', 'automation', $3::jsonb, '[]'::jsonb, $4, now())`,
    [id, randomUUID(), JSON.stringify({ automationRunId: runId }), randomUUID()]
  );
  return id;
}

async function selected(): Promise<Set<string>> {
  const rows = await run(
    drizzleSql`select id from focus_sessions where ${endedRunSessionWhere()}`
  );
  return new Set(rows.map((r) => String(r.id)));
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    create table focus_sessions (
      id uuid primary key, user_id uuid, status text, origin text, playbook_id uuid,
      metadata jsonb, expected_outputs jsonb, channel_id uuid, updated_at timestamptz);
    create table automation_runs (id uuid primary key, status text);
    create table playbook_runs (id uuid primary key, session_id uuid, status text);
    create table proposals (
      id uuid primary key, session_id uuid, status text, proposal_type text,
      target_type text, target_id text, created_at timestamptz);
    create table messages (
      id uuid primary key, channel_id uuid, author_type text, deleted_at timestamptz, metadata jsonb);
  `);
  // Enough runs that a sequential probe costs more than the key probe.
  await client.exec(`
    insert into automation_runs (id, status)
    select gen_random_uuid(), 'completed' from generate_series(1, 5000);
  `);
  await client.query(
    `insert into automation_runs (id, status) values ($1, 'completed'), ($2, 'running')`,
    [ENDED_RUN, RUNNING_RUN]
  );
  await client.exec(`analyze automation_runs;`);
});

afterAll(async () => {
  await client.close();
});

describe("endedRunSessionWhere: the automation run join", () => {
  it("probes automation_runs through its primary key", async () => {
    await runSession(ENDED_RUN);
    const plan = (
      await run(
        drizzleSql`explain select id from focus_sessions where ${endedRunSessionWhere()}`
      )
    )
      .map((r) => String(r["QUERY PLAN"]))
      .join("\n");
    // Non-vacuity: the plan is the sweep's, and it reaches automation_runs.
    expect(plan).toMatch(/automation_runs/);
    expect(plan).toMatch(/Index Scan using automation_runs_pkey/);
    expect(plan).not.toMatch(/Seq Scan on automation_runs/);
  });

  it("selects a session whose run ended, and no other", async () => {
    const ended = await runSession(ENDED_RUN);
    const running = await runSession(RUNNING_RUN);
    const noRun = await runSession(randomUUID());
    const got = await selected();
    expect(got.has(ended)).toBe(true);
    expect(got.has(running)).toBe(false);
    expect(got.has(noRun)).toBe(false);
  });

  it("a malformed run id neither throws nor matches", async () => {
    const malformed = await Promise.all(
      [
        "not-a-uuid",
        "",
        ENDED_RUN.toUpperCase(),
        `{${ENDED_RUN}}`,
        ENDED_RUN.replace(/-/g, ""),
        ` ${ENDED_RUN}`,
        42,
      ].map(runSession)
    );
    const got = await selected(); // a bare ::uuid cast throws here
    for (const id of malformed) expect(got.has(id)).toBe(false);
  });
});

describe("uuidFromTextSql", () => {
  it("answers exactly what `pk::text = text` answered, for every input", async () => {
    const inputs = [
      ENDED_RUN,
      ENDED_RUN.toUpperCase(),
      `{${ENDED_RUN}}`,
      ENDED_RUN.replace(/-/g, ""),
      "not-a-uuid",
      "",
      null,
    ];
    for (const text of inputs) {
      const t = drizzleSql`${text}::text`;
      const [row] = await run(drizzleSql`select
        exists (select 1 from automation_runs ar where ar.id::text = ${t}) as old_match,
        exists (select 1 from automation_runs ar where ar.id = ${uuidFromTextSql(t)}) as new_match`);
      expect({ text, matched: row!.new_match }).toEqual({
        text,
        matched: row!.old_match,
      });
    }
    // Non-vacuity: the table holds the canonical id, so one input did match.
    const [hit] = await run(
      drizzleSql`select ${uuidFromTextSql(drizzleSql`${ENDED_RUN}::text`)} as u`
    );
    expect(String(hit!.u)).toBe(ENDED_RUN);
  });
});

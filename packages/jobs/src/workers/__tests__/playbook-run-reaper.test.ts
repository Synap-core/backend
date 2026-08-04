import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
  RUN_SESSION_NOT_ACTIVE,
  PLAYBOOK_RUN_REAPER_STALE_HOURS,
  PLAYBOOK_RUN_REAPER_CRON,
} from "../playbook-run-reaper.js";

const compiled = new PgDialect().sqlToQuery(RUN_SESSION_NOT_ACTIVE);

// playbook_runs has no updatedAt, so "actively worked" is read off the linked
// focus_sessions.updatedAt (the same signal focus-session-reaper keys on). Lock
// the exemption SHAPE so a future edit can't silently key on the wrong signal
// (e.g. the run's startedAt, which would false-fail every live external-agent run).
describe("RUN_SESSION_NOT_ACTIVE exemption predicate", () => {
  const rendered = compiled.sql;

  it("keys activity on the SESSION's updated_at, not the run", () => {
    expect(rendered).toContain("focus_sessions");
    expect(rendered).toContain("updated_at");
    expect(rendered).toMatch(/interval '1 hour'/);
    expect(compiled.params).toContain(PLAYBOOK_RUN_REAPER_STALE_HOURS);
  });

  it("only exempts an active/paused session (terminal/stale is reapable)", () => {
    expect(rendered).toContain("'active'");
    expect(rendered).toContain("'paused'");
    expect(rendered).toContain("NOT EXISTS");
  });

  it("correlates the exemption to the run being finalized", () => {
    expect(rendered).toContain('"playbook_runs"."session_id"');
  });
});

describe("reaper constants", () => {
  it("uses a generous 24h stale window and a ~30min cron", () => {
    expect(PLAYBOOK_RUN_REAPER_STALE_HOURS).toBe(24);
    expect(PLAYBOOK_RUN_REAPER_CRON).toBe("*/30 * * * *");
  });
});

/**
 * BEHAVIOURAL suite — the REAL compiled WHERE against a REAL Postgres.
 *
 * Self-skips unless REAPER_TEST_DATABASE_URL is set (the jobs suite has no live
 * DB in CI). Two throwaway tables suffice — the WHERE touches playbook_runs
 * (status, started_at, session_id) and focus_sessions (id, status, updated_at):
 *
 *   REAPER_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
 *     npx vitest run src/workers/__tests__/playbook-run-reaper.test.ts
 */
const TEST_DB_URL = process.env.REAPER_TEST_DATABASE_URL;
const behavioural = TEST_DB_URL ? describe : describe.skip;

behavioural("playbook run reaper WHERE against a live Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  const SCHEMA = "playbook_reaper_test";
  const H = PLAYBOOK_RUN_REAPER_STALE_HOURS;

  type SessionSpec = {
    status: "active" | "paused" | "stale" | "closed";
    updatedAtHours: number; // offset from now; negative = past
  } | null;

  /** Insert a run (+ optional session) and ask whether the reaper WHERE selects it. */
  async function wouldBeReaped(
    startedAtHours: number,
    session: SessionSpec
  ): Promise<boolean> {
    const runId = `run-${Math.random().toString(36).slice(2)}`;
    let sessionId: string | null = null;
    if (session) {
      sessionId = `sess-${Math.random().toString(36).slice(2)}`;
      await sql`
        INSERT INTO focus_sessions (id, status, updated_at)
        VALUES (${sessionId}, ${session.status},
          now() + (${session.updatedAtHours}::int * interval '1 hour'))`;
    }
    await sql`
      INSERT INTO playbook_runs (id, status, session_id, started_at)
      VALUES (${runId}, 'running', ${sessionId},
        now() + (${startedAtHours}::int * interval '1 hour'))`;

    // The FULL reaper WHERE: status running + age floor + session-not-active.
    const rows = await sql.unsafe(
      `SELECT id FROM playbook_runs
       WHERE "playbook_runs"."status" = 'running'
         AND "playbook_runs"."started_at" < now() - (${H}::int * interval '1 hour')
         AND "playbook_runs"."id" = $${compiled.params.length + 1}
         AND ${compiled.sql}`,
      [...compiled.params, runId] as never[]
    );
    return rows.length === 1;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    await sql.unsafe(`SET search_path TO ${SCHEMA}`);
    await sql.unsafe(`CREATE TABLE focus_sessions (
      id text PRIMARY KEY, status text NOT NULL, updated_at timestamptz NOT NULL)`);
    await sql.unsafe(`CREATE TABLE playbook_runs (
      id text PRIMARY KEY, status text NOT NULL, session_id text,
      started_at timestamptz NOT NULL)`);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it("REAPS an old run with a quiet (stale-aged) active session", async () => {
    expect(
      await wouldBeReaped(-(H + 5), {
        status: "active",
        updatedAtHours: -(H + 1),
      })
    ).toBe(true);
  });

  it("REAPS an old run whose session is gone (null)", async () => {
    expect(await wouldBeReaped(-(H + 5), null)).toBe(true);
  });

  it("REAPS an old run whose session is already closed", async () => {
    expect(
      await wouldBeReaped(-(H + 5), { status: "closed", updatedAtHours: -1 })
    ).toBe(true);
  });

  it("does NOT reap when the session was touched recently (active work)", async () => {
    expect(
      await wouldBeReaped(-(H + 5), { status: "active", updatedAtHours: -1 })
    ).toBe(false);
  });

  it("does NOT reap a young run even with a quiet session", async () => {
    expect(
      await wouldBeReaped(-1, { status: "active", updatedAtHours: -(H + 1) })
    ).toBe(false);
  });
});

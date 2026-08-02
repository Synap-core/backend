import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
  RUN_NOT_DELAY_SUSPENDED,
  REAPER_STALE_MINUTES,
  REAPER_DELAY_GRACE_MINUTES,
  AUTOMATION_RUN_REAPER_CRON,
} from "../automation-run-reaper.js";

const compiled = new PgDialect().sqlToQuery(RUN_NOT_DELAY_SUSPENDED);

// The reaper's delay-suspended exemption is a SQL fragment, not a JS predicate,
// so we lock its SHAPE against the exact trap it was written to avoid: the delay
// marker lives in `output->>'status'`, NOT the `status` column (which has no
// 'delayed' value). A future edit that keys on the column would wrongly reap
// every suspended run — this assertion fails loud if that shape regresses.
describe("RUN_NOT_DELAY_SUSPENDED exemption predicate", () => {
  const rendered = compiled.sql;

  it("keys the delay marker on the output JSONB, not the status column", () => {
    expect(rendered).toContain("output->>'status'");
    expect(rendered).toContain("'delayed'");
  });

  it("exempts only when the delayed step is the most recent (no later step)", () => {
    expect(rendered).toContain("NOT EXISTS");
    expect(rendered).toContain("later.started_at > s.started_at");
  });

  it("correlates the exemption to the run being finalized", () => {
    expect(rendered).toContain("automation_step_runs");
    expect(rendered).toContain('"automation_runs"."id"');
  });

  // The bound is the whole point of the 2026-08 fix: without it the exemption is
  // a permanent leak once `automation-execute` runs `retryLimit: 0`. These are
  // DB-free so CI catches a removal even where no Postgres is reachable; the
  // behavioural proof lives in the suite below.
  it("bounds the exemption by the delay step's own resumeAfter", () => {
    expect(rendered).toContain("output->>'resumeAfter'");
    expect(rendered).toContain("::timestamptz");
    expect(rendered).toMatch(/interval '1 minute'/);
    expect(compiled.params).toContain(REAPER_DELAY_GRACE_MINUTES);
  });

  it("guards the timestamptz cast with an ordered CASE, not a bare AND", () => {
    // `::timestamptz` THROWS on a malformed string and Postgres does not
    // guarantee AND-operand evaluation order, so the format guard must sit in a
    // CASE (ordered) rather than as a sibling conjunct.
    expect(rendered).toContain("CASE");
    expect(rendered).toContain("ELSE true");
    const caseAt = rendered.indexOf("CASE");
    const castAt = rendered.indexOf("::timestamptz");
    expect(caseAt).toBeGreaterThanOrEqual(0);
    expect(castAt).toBeGreaterThan(caseAt);
  });
});

describe("reaper constants", () => {
  it("uses a bounded stale window and a ~5min cron", () => {
    expect(REAPER_STALE_MINUTES).toBe(45);
    expect(AUTOMATION_RUN_REAPER_CRON).toBe("*/5 * * * *");
  });

  it("gives a resumed walk the same slack as any other run", () => {
    expect(REAPER_DELAY_GRACE_MINUTES).toBe(REAPER_STALE_MINUTES);
  });
});

/**
 * BEHAVIOURAL suite — runs the REAL compiled predicate against a REAL Postgres.
 *
 * The jobs suite has no live database in CI (the `DATABASE_URL` default in
 * `vitest.config.ts` points at a localhost pod that is not up), so this block
 * self-skips unless `REAPER_TEST_DATABASE_URL` is set. It needs only two
 * throwaway tables — the predicate touches `automation_runs.id` and four
 * `automation_step_runs` columns — so any scratch database will do:
 *
 *   initdb -D /tmp/pg && pg_ctl -D /tmp/pg -o "-p 55432" start
 *   REAPER_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
 *     npx vitest run src/workers/__tests__/automation-run-reaper.test.ts
 *
 * Nothing is mocked: the exemption's truth value comes from Postgres evaluating
 * the exact SQL the reaper's UPDATE ... WHERE binds.
 */
const TEST_DB_URL = process.env.REAPER_TEST_DATABASE_URL;
const behavioural = TEST_DB_URL ? describe : describe.skip;

behavioural("RUN_NOT_DELAY_SUSPENDED against a live Postgres", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sql: ReturnType<typeof postgres>;
  const SCHEMA = "reaper_predicate_test";

  /** A step row, offsets in minutes relative to now (negative = past). */
  type Step = {
    startedAtMinutes: number;
    output: Record<string, unknown> | null;
  };

  /**
   * Insert one run with the given steps, then ask Postgres whether the reaper's
   * WHERE clause selects it. Returns true when the run WOULD BE REAPED.
   */
  async function wouldBeReaped(steps: Step[]): Promise<boolean> {
    const runId = `run-${Math.random().toString(36).slice(2)}`;
    await sql`INSERT INTO automation_runs (id) VALUES (${runId})`;
    for (const step of steps) {
      await sql`
        INSERT INTO automation_step_runs (run_id, started_at, output)
        VALUES (
          ${runId},
          now() + (${step.startedAtMinutes}::int * interval '1 minute'),
          ${step.output === null ? null : JSON.stringify(step.output)}::text::jsonb
        )`;
    }
    const rows = await sql.unsafe(
      `SELECT "automation_runs"."id" FROM automation_runs WHERE "automation_runs"."id" = $${
        compiled.params.length + 1
      } AND ${compiled.sql}`,
      [...compiled.params, runId] as never[]
    );
    return rows.length === 1;
  }

  /** A delay step as `automation-executor.ts` case "delay" writes it. */
  const delayStep = (
    startedAtMinutes: number,
    resumeAfterMinutesFromNow: number | null | "malformed"
  ): Step => ({
    startedAtMinutes,
    output: {
      status: "delayed",
      ...(resumeAfterMinutesFromNow === null
        ? {}
        : {
            resumeAfter:
              resumeAfterMinutesFromNow === "malformed"
                ? "soon-ish"
                : new Date(
                    Date.now() + resumeAfterMinutesFromNow * 60_000
                  ).toISOString(),
          }),
    },
  });

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    await sql.unsafe(`SET search_path TO ${SCHEMA}`);
    await sql.unsafe(`CREATE TABLE automation_runs (id text PRIMARY KEY)`);
    await sql.unsafe(`CREATE TABLE automation_step_runs (
      id bigserial PRIMARY KEY,
      run_id text NOT NULL,
      started_at timestamptz NOT NULL,
      output jsonb
    )`);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  // CASE 1 — inside the delay window: exempt.
  it("does NOT reap a run still inside its delay window", async () => {
    expect(await wouldBeReaped([delayStep(-60, 30)])).toBe(false);
  });

  it("does NOT reap a legitimately long delay (7 days out)", async () => {
    expect(await wouldBeReaped([delayStep(-60, 7 * 24 * 60)])).toBe(false);
  });

  it("does NOT reap within the grace after resumeAfter elapsed", async () => {
    expect(
      await wouldBeReaped([delayStep(-600, -(REAPER_DELAY_GRACE_MINUTES - 5))])
    ).toBe(false);
  });

  // CASE 2 — past resumeAfter by more than the grace: reaped. This is the
  // assertion the unbounded predicate cannot satisfy.
  it("REAPS a run whose resumeAfter is past by more than the grace", async () => {
    expect(
      await wouldBeReaped([delayStep(-600, -(REAPER_DELAY_GRACE_MINUTES + 5))])
    ).toBe(true);
  });

  it("REAPS a run stranded a week past its resumeAfter", async () => {
    expect(await wouldBeReaped([delayStep(-20_000, -7 * 24 * 60)])).toBe(true);
  });

  // CASE 3 — undateable marker: the ELSE branch keeps the historical unbounded
  // exemption. Pinning the ACTUAL behaviour, and proving the cast never throws.
  it("keeps a delay step with NO resumeAfter exempt (ELSE branch)", async () => {
    expect(await wouldBeReaped([delayStep(-600, null)])).toBe(false);
  });

  it("keeps a delay step with an UNPARSEABLE resumeAfter exempt, without throwing", async () => {
    // A bare `AND`-sibling regex guard would let `'soon-ish'::timestamptz` raise
    // 22007 here; the CASE is what makes this resolve instead of erroring.
    await expect(wouldBeReaped([delayStep(-600, "malformed")])).resolves.toBe(
      false
    );
  });

  it("keeps a delay step whose output has no resumeAfter key at all exempt", async () => {
    expect(
      await wouldBeReaped([
        { startedAtMinutes: -600, output: { status: "delayed" } },
      ])
    ).toBe(false);
  });

  // Pre-existing invariants the bound must not have broken.
  it("REAPS a run with no steps at all (the orphan we came for)", async () => {
    expect(await wouldBeReaped([])).toBe(true);
  });

  it("REAPS a run whose delay step is superseded by a later step", async () => {
    expect(
      await wouldBeReaped([
        delayStep(-600, 7 * 24 * 60),
        { startedAtMinutes: -300, output: { status: "completed" } },
      ])
    ).toBe(true);
  });

  it("does NOT reap when the delay step is the latest despite EARLIER steps", async () => {
    expect(
      await wouldBeReaped([
        { startedAtMinutes: -700, output: { status: "completed" } },
        delayStep(-600, 30),
      ])
    ).toBe(false);
  });
});

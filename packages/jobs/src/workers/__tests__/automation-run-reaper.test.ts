import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  RUN_NOT_DELAY_SUSPENDED,
  REAPER_STALE_MINUTES,
  AUTOMATION_RUN_REAPER_CRON,
} from "../automation-run-reaper.js";

// The reaper's delay-suspended exemption is a SQL fragment, not a JS predicate,
// so we lock its SHAPE against the exact trap it was written to avoid: the delay
// marker lives in `output->>'status'`, NOT the `status` column (which has no
// 'delayed' value). A future edit that keys on the column would wrongly reap
// every suspended run — this assertion fails loud if that shape regresses.
describe("RUN_NOT_DELAY_SUSPENDED exemption predicate", () => {
  const rendered = new PgDialect().sqlToQuery(RUN_NOT_DELAY_SUSPENDED).sql;

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
});

describe("reaper constants", () => {
  it("uses a bounded stale window and a ~5min cron", () => {
    expect(REAPER_STALE_MINUTES).toBe(45);
    expect(AUTOMATION_RUN_REAPER_CRON).toBe("*/5 * * * *");
  });
});

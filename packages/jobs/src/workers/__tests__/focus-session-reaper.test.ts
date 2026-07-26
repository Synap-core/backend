import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  FOCUS_SESSION_REAPER_CRON,
  REAPER_STALE_HOURS,
  SESSION_IS_STALE,
} from "../focus-session-reaper.js";

// C8 lifecycle hygiene: lock the reaper's constants. A regression here (e.g.
// keying the staleness window off startedAt instead of updatedAt, or widening
// the window so it never fires) is exactly the "6+ days running, never
// closed" defect the reaper was written to catch.
describe("focus-session reaper constants", () => {
  it("uses a bounded stale window (hours, not days) and an hourly cron", () => {
    expect(REAPER_STALE_HOURS).toBe(24);
    expect(FOCUS_SESSION_REAPER_CRON).toBe("0 * * * *");
  });
});

describe("SESSION_IS_STALE predicate", () => {
  const rendered = new PgDialect().sqlToQuery(SESSION_IS_STALE!).sql;

  it("keys staleness off updated_at, NOT started_at — an actively-worked, long-running session must never be reaped on age alone", () => {
    expect(rendered).toContain("updated_at");
    expect(rendered).not.toContain("started_at");
  });

  it("only targets the live statuses (active/paused), never a terminal one", () => {
    expect(rendered).toContain("IN ('active', 'paused')");
  });
});

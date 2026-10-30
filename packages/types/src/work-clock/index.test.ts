import { describe, expect, it } from "vitest";
import { WORK_CLOCK, WORK_CLOCK_RUNGS, workClockIn } from "./index.js";
import { SESSION_WORKING_WINDOW_MS } from "../run-activity/live.js";
import { DEFAULT_STUCK_THRESHOLD_HOURS } from "../run-activity/thresholds.js";
import { SESSION_GONE_QUIET_MS } from "../units/stuck.js";
import { NEEDS_YOU_STOPPED_AFTER_MS } from "../needs-you/rule.js";
import { NEXT_MOVE_STUCK_DAYS } from "../lens/next-moves.js";
import { LENS_KPI_STATED_OLD_AFTER_MS } from "../lens/header.js";
import { AGENT_STALE_AFTER_DAYS } from "../agents/index.js";
import { REVIEW_LATER_AFTER_MS } from "../proposals/fate.js";

describe("the work clock ladder", () => {
  it("has the four rungs at their decided values", () => {
    expect(WORK_CLOCK).toEqual({
      live: 5 * 60_000,
      quiet: 30 * 60_000,
      stale: 24 * 3_600_000,
      stuck: 7 * 24 * 3_600_000,
    });
  });

  it("climbs: each rung is later than the one before", () => {
    const values = WORK_CLOCK_RUNGS.map((r) => WORK_CLOCK[r]);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
  });

  it("converts a rung into the unit a reader stores", () => {
    expect(workClockIn("live", "minutes")).toBe(5);
    expect(workClockIn("stale", "hours")).toBe(24);
    expect(workClockIn("stuck", "days")).toBe(7);
  });

  it("every clock that is a rung reads the rung's value", () => {
    expect(SESSION_WORKING_WINDOW_MS).toBe(WORK_CLOCK.live);
    expect(SESSION_GONE_QUIET_MS).toBe(WORK_CLOCK.quiet);
    expect(DEFAULT_STUCK_THRESHOLD_HOURS * 3_600_000).toBe(WORK_CLOCK.stale);
    expect(NEEDS_YOU_STOPPED_AFTER_MS).toBe(WORK_CLOCK.stuck);
    expect(NEXT_MOVE_STUCK_DAYS * 24 * 3_600_000).toBe(WORK_CLOCK.stuck);
    expect(LENS_KPI_STATED_OLD_AFTER_MS).toBe(WORK_CLOCK.stuck);
    expect(AGENT_STALE_AFTER_DAYS * 24 * 3_600_000).toBe(WORK_CLOCK.stuck);
    expect(REVIEW_LATER_AFTER_MS).toBe(WORK_CLOCK.stuck);
  });
});

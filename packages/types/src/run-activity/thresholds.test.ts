import { describe, expect, it } from "vitest";
import { isRecentFailure } from "./thresholds.js";

describe("isRecentFailure — the ONE cutoff rule (the run groupers' SQL is its twin)", () => {
  it("dates a failure by completedAt, else startedAt, against the 7-day window", () => {
    const now = Date.UTC(2026, 8, 28);
    const day = 24 * 60 * 60 * 1000;
    expect(
      isRecentFailure(
        {
          startedAt: new Date(now - 8 * day),
          completedAt: new Date(now - day),
        },
        now
      )
    ).toBe(true);
    expect(
      isRecentFailure(
        { startedAt: new Date(now - 8 * day), completedAt: null },
        now
      )
    ).toBe(false);
    expect(isRecentFailure({ startedAt: new Date(now - 6 * day) }, now)).toBe(
      true
    );
  });
});

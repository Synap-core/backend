import { describe, it, expect } from "vitest";
import {
  REQUEST_LATER_CHOICES,
  REQUEST_LATER_MAX_MS,
  requestLaterUntil,
} from "./request-later.js";

/** A local date, so the test reads the device clock the helper reads. */
const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min);

describe("requestLaterUntil — the three Later choices", () => {
  it("offers three choices, in order", () => {
    expect(REQUEST_LATER_CHOICES).toEqual([
      "in_3_hours",
      "tomorrow",
      "next_week",
    ]);
  });

  it("in 3 hours is 3 hours from now", () => {
    const now = local(2026, 10, 30, 15, 20);
    expect(requestLaterUntil("in_3_hours", now).getTime() - now.getTime()).toBe(
      3 * 3_600_000
    );
  });

  it("tomorrow is tomorrow at 8:00, local", () => {
    expect(requestLaterUntil("tomorrow", local(2026, 10, 30, 22, 5))).toEqual(
      local(2026, 10, 31, 8)
    );
  });

  it("next week is the next Monday at 8:00 (a week on, from a Monday)", () => {
    // 30 Oct 2026 is a Friday.
    expect(requestLaterUntil("next_week", local(2026, 10, 30, 9))).toEqual(
      local(2026, 11, 2, 8)
    );
    expect(requestLaterUntil("next_week", local(2026, 11, 1, 9))).toEqual(
      local(2026, 11, 2, 8)
    );
    expect(requestLaterUntil("next_week", local(2026, 11, 2, 7))).toEqual(
      local(2026, 11, 9, 8)
    );
  });

  it("every choice is in the future and inside the door's 30-day bound", () => {
    const now = local(2026, 10, 30, 23, 59);
    for (const choice of REQUEST_LATER_CHOICES) {
      const t = requestLaterUntil(choice, now).getTime();
      expect(t).toBeGreaterThan(now.getTime());
      expect(t - now.getTime()).toBeLessThanOrEqual(REQUEST_LATER_MAX_MS);
    }
  });
});

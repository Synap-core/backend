import { describe, it, expect } from "vitest";
import {
  REQUEST_LATER_CHOICES,
  REQUEST_LATER_MAX_MS,
  laterTimeProblem,
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

describe("laterTimeProblem — the one Later time check (a request's and an ask's)", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() + ms);

  it("a time in the future, within the limit, is fine", () => {
    expect(laterTimeProblem(at(60_000), now, "an ask")).toBeNull();
    expect(
      laterTimeProblem(at(REQUEST_LATER_MAX_MS), now, "a request")
    ).toBeNull();
  });

  it("now, the past or an unreadable time is refused", () => {
    expect(laterTimeProblem(now, now, "an ask")).toBe(
      "Later needs a time in the future."
    );
    expect(laterTimeProblem(at(-1), now, "a request")).toBe(
      "Later needs a time in the future."
    );
    expect(laterTimeProblem(new Date(NaN), now, "an ask")).toBe(
      "Later needs a time in the future."
    );
  });

  it("past the limit names the limit's own day count and the thing set aside", () => {
    const days = REQUEST_LATER_MAX_MS / (24 * 60 * 60 * 1000);
    expect(laterTimeProblem(at(REQUEST_LATER_MAX_MS + 1), now, "an ask")).toBe(
      `Later can set an ask aside for ${days} days at most.`
    );
    expect(
      laterTimeProblem(at(REQUEST_LATER_MAX_MS + 1), now, "a request")
    ).toBe(`Later can set a request aside for ${days} days at most.`);
  });
});

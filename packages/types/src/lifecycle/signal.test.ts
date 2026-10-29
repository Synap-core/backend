/**
 * The date rule of a step (status-flow W6): calendar time, a date-only value
 * due at the END of its day, late once due, approaching within the default
 * window before, and `beganAt` stable for one episode.
 */
import { describe, it, expect } from "vitest";
import { DATE_APPROACHING_DAYS, dateDueAt, dateSignalOf } from "./signal.js";

const NOW = Date.parse("2026-10-29T10:00:00.000Z");

describe("dateSignalOf", () => {
  it("a date-only value is due at the end of its day", () => {
    expect(new Date(dateDueAt("2026-10-29")!).toISOString()).toBe(
      "2026-10-30T00:00:00.000Z"
    );
    // Due today: not late yet, approaching.
    expect(dateSignalOf("2026-10-29", NOW)?.signal).toBe("approaching");
    expect(dateSignalOf("2026-10-28", NOW)).toEqual({
      signal: "late",
      dueAt: "2026-10-29T00:00:00.000Z",
      beganAt: "2026-10-29T00:00:00.000Z",
    });
  });

  it("a timestamp is due at that instant", () => {
    expect(dateSignalOf("2026-10-29T09:59:00.000Z", NOW)?.signal).toBe("late");
    expect(dateSignalOf("2026-10-29T10:01:00.000Z", NOW)?.signal).toBe(
      "approaching"
    );
  });

  it(`approaching is the ${DATE_APPROACHING_DAYS} days before; further out is nothing`, () => {
    const inside = dateSignalOf("2026-10-31", NOW);
    expect(inside?.signal).toBe("approaching");
    // The window opened 3 days before the due moment (Nov 1, 00:00).
    expect(inside?.beganAt).toBe("2026-10-29T00:00:00.000Z");
    expect(dateSignalOf("2026-11-05", NOW)).toBeNull();
  });

  it("anything that is not a date is no signal", () => {
    for (const v of [null, undefined, "", "soon", 42, {}]) {
      expect(dateSignalOf(v, NOW)).toBeNull();
    }
  });
});

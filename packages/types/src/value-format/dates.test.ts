import { describe, expect, it } from "vitest";
import {
  daysUntil,
  formatAbsoluteDate,
  formatDateTime,
  formatDayEyebrow,
  formatDayLong,
  formatElapsed,
  formatFromNow,
  formatMonthShort,
  formatMonthYear,
  formatRelative,
  formatTime,
  formatUntil,
  formatWeekday,
} from "./dates.js";

// A fixed instant: nothing here reads the wall clock.
const NOW = new Date("2026-09-04T12:00:00.000Z").getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ahead = (ms: number) => new Date(NOW + ms).toISOString();

describe("formatRelative — the backward ladder", () => {
  it.each([
    [0, "just now"],
    [59 * SECOND, "just now"],
    [MINUTE, "1m ago"],
    [59 * MINUTE, "59m ago"],
    [HOUR, "1h ago"],
    [23 * HOUR, "23h ago"],
    [DAY, "Yesterday"],
    [DAY + 11 * HOUR, "Yesterday"],
    [2 * DAY, "2d ago"],
    [6 * DAY, "6d ago"],
    [7 * DAY, "1 week ago"],
    [14 * DAY, "2 weeks ago"],
    [27 * DAY, "3 weeks ago"],
  ])("%dms ago → %s", (elapsed, expected) => {
    expect(formatRelative(ago(elapsed), NOW)).toBe(expected);
  });

  it("hands off to the absolute date at four weeks, with the year once it differs", () => {
    expect(formatRelative(ago(28 * DAY), NOW)).toBe("7 Aug");
    expect(formatRelative(ago(730 * DAY), NOW)).toMatch(
      /^\d{1,2} [A-Z][a-z]{2} 2024$/
    );
  });

  it("never the Intl long form the desk used to print", () => {
    expect(formatRelative(ago(2 * HOUR), NOW)).toBe("2h ago");
    expect(formatRelative(ago(2 * HOUR), NOW)).not.toMatch(/hours/);
  });

  it("a future stamp reads 'just now', never a negative duration", () => {
    expect(formatRelative(ahead(3 * MINUTE), NOW)).toBe("just now");
  });

  it("missing or unparseable input yields '' rather than 'Invalid Date'", () => {
    for (const v of [undefined, null, "", "not a date"]) {
      expect(formatRelative(v, NOW)).toBe("");
    }
  });

  it("accepts epoch ms and a Date", () => {
    expect(formatRelative(NOW - 5 * MINUTE, NOW)).toBe("5m ago");
    expect(formatRelative(new Date(NOW - 5 * MINUTE), NOW)).toBe("5m ago");
  });
});

describe("formatUntil — the forward ladder", () => {
  it("walks every boundary", () => {
    expect(formatUntil(ahead(45 * SECOND), NOW)).toBe("now");
    expect(formatUntil(ahead(MINUTE), NOW)).toBe("in 1m");
    expect(formatUntil(ahead(59 * MINUTE), NOW)).toBe("in 59m");
    expect(formatUntil(ahead(HOUR), NOW)).toBe("in 1h");
    expect(formatUntil(ahead(23 * HOUR), NOW)).toBe("in 23h");
    expect(formatUntil(ahead(DAY), NOW)).toBe("tomorrow");
    expect(formatUntil(ahead(2 * DAY), NOW)).toBe("in 2d");
    expect(formatUntil(ahead(7 * DAY), NOW)).toBe("in 1 week");
    expect(formatUntil(ahead(14 * DAY), NOW)).toBe("in 2 weeks");
    expect(formatUntil(ahead(40 * DAY), NOW)).toBe("14 Oct");
  });

  it("an arrived instant reads 'now'", () => {
    expect(formatUntil(ago(HOUR), NOW)).toBe("now");
  });
});

describe("formatFromNow — either side of now", () => {
  it("ahead reads the forward ladder, behind the backward one", () => {
    expect(formatFromNow(ahead(3 * DAY), NOW)).toBe("in 3d");
    expect(formatFromNow(ago(3 * DAY), NOW)).toBe("3d ago");
  });

  it("clock skew under a minute stays on the past side", () => {
    expect(formatFromNow(ahead(30 * SECOND), NOW)).toBe("just now");
  });

  it("'' for nothing", () => {
    expect(formatFromNow(null, NOW)).toBe("");
  });
});

describe("formatAbsoluteDate — the one absolute form", () => {
  it("day, then a month word; the year only when it is not now's", () => {
    expect(formatAbsoluteDate("2026-03-05T09:00:00.000Z", NOW)).toBe("5 Mar");
    expect(formatAbsoluteDate("2025-09-20T09:00:00.000Z", NOW)).toBe(
      "20 Sep 2025"
    );
    expect(formatAbsoluteDate("2027-01-02T09:00:00.000Z", NOW)).toBe(
      "2 Jan 2027"
    );
  });

  it("never a numeric date and never 'Sept'", () => {
    for (let m = 0; m < 12; m++) {
      expect(formatAbsoluteDate(new Date(2025, m, 15), NOW)).toMatch(
        /^15 [A-Z][a-z]{2} 2025$/
      );
    }
  });

  it("a date-only value lands on its own local day", () => {
    // `new Date("2026-07-25")` is UTC midnight, the 24th west of UTC.
    expect(formatAbsoluteDate("2026-07-25", NOW)).toBe("25 Jul");
  });

  it("'' for missing or unparseable", () => {
    expect(formatAbsoluteDate(undefined)).toBe("");
    expect(formatAbsoluteDate("not a date")).toBe("");
  });
});

describe("formatTime / formatDateTime", () => {
  it("the 24-hour clock, zero-padded", () => {
    expect(formatTime(new Date(2026, 9, 15, 13, 5))).toBe("13:05");
    expect(formatTime(new Date(2026, 9, 15, 9, 41))).toBe("09:41");
    expect(formatTime(new Date(2026, 9, 15, 9, 41, 7), { seconds: true })).toBe(
      "09:41:07"
    );
    expect(formatTime("nope")).toBe("");
  });

  it("a date and its time, joined", () => {
    expect(formatDateTime(new Date(2026, 9, 15, 13, 55), NOW)).toBe(
      "15 Oct · 13:55"
    );
    expect(formatDateTime(null, NOW)).toBe("");
  });
});

describe("day and month names", () => {
  it("spells them itself, so every engine reads the same", () => {
    const fri = new Date(2026, 8, 4, 9);
    expect(formatDayEyebrow(fri)).toBe("Friday 4 September");
    expect(formatDayLong(fri)).toBe("Friday 4 September 2026");
    expect(formatMonthYear(fri)).toBe("September 2026");
    expect(formatMonthShort(fri)).toBe("Sep");
    expect(formatWeekday(fri)).toBe("F");
    expect(formatWeekday(fri, "long")).toBe("Friday");
    expect(formatWeekday(fri, "short")).toBe("Fri");
  });

  it("'' for an invalid date rather than 'Invalid Date'", () => {
    expect(formatDayEyebrow(new Date("nope"))).toBe("");
    expect(formatMonthYear(new Date("nope"))).toBe("");
  });
});

describe("daysUntil", () => {
  it("floors, and is negative once passed", () => {
    expect(daysUntil("2026-09-04T23:00:00.000Z", NOW)).toBe(0);
    expect(daysUntil("2026-09-04T11:00:00.000Z", NOW)).toBe(-1);
    expect(daysUntil("2026-09-18T12:00:00.000Z", NOW)).toBe(14);
  });

  it("null, never 0, for no date", () => {
    for (const v of [null, undefined, "", "next tuesday"]) {
      expect(daysUntil(v, NOW)).toBeNull();
    }
  });
});

describe("formatFromNow — a date-only value counts calendar days", () => {
  // Local noon, so the calendar day is unambiguous in every zone the suite runs in.
  const noon = new Date(2026, 8, 4, 12).getTime();
  it.each([
    ["2026-09-04", "today"],
    ["2026-09-05", "tomorrow"],
    ["2026-09-03", "Yesterday"],
    ["2026-09-08", "in 4d"],
    ["2026-08-31", "4d ago"],
    ["2026-09-18", "in 2 weeks"],
    ["2026-12-25", "25 Dec"],
  ])("%s → %s", (day, expected) => {
    expect(formatFromNow(day, noon)).toBe(expected);
  });

  it("a due date of today never reads as hours since its midnight", () => {
    expect(formatFromNow("2026-09-04", noon)).not.toMatch(/h ago/);
  });
});

describe("formatElapsed — the running span a state pill carries", () => {
  it.each([
    [0, "<1m"],
    [59 * SECOND, "<1m"],
    [MINUTE, "1m"],
    [59 * MINUTE, "59m"],
    [HOUR, "1h"],
    [2 * HOUR + 5 * MINUTE, "2h 5m"],
    [23 * HOUR + 59 * MINUTE, "23h 59m"],
    [DAY, "1d"],
    [9 * DAY + 3 * HOUR, "9d"],
  ])("%i ms in the state reads %s", (elapsed, expected) => {
    expect(formatElapsed(ago(elapsed), NOW)).toBe(expected);
  });

  it("a start ahead of the clock (skew) is never a negative span", () => {
    expect(formatElapsed(ahead(5 * MINUTE), NOW)).toBe("<1m");
  });

  it("no start, no slot", () => {
    expect(formatElapsed(null, NOW)).toBe("");
    expect(formatElapsed("not a date", NOW)).toBe("");
  });
});

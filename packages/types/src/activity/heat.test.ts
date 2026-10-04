import { describe, expect, it } from "vitest";
import {
  ACTIVITY_DAILY_MAX_DAYS,
  activityCellLabel,
  activityCountLabel,
  activityDayRange,
  activityHeatSummary,
  activityLevel,
  activityThresholds,
  activityWindow,
  buildActivityHeat,
  calendarDayIn,
  isValidTimeZone,
  todayInTimeZone,
} from "./index.js";

const ms = (iso: string) => Date.parse(iso);

describe("activityDayRange — a day's instants in the viewer's zone", () => {
  it("is local midnight to local midnight (Pacific/Auckland, +13 in October)", () => {
    expect(activityDayRange("2026-10-03", "Pacific/Auckland")).toEqual({
      since: "2026-10-02T11:00:00.000Z",
      until: "2026-10-03T11:00:00.000Z",
    });
  });

  it("puts 23:30 on the day and 00:30 on the next (Auckland)", () => {
    const day = activityDayRange("2026-10-03", "Pacific/Auckland");
    const lateNight = ms("2026-10-03T10:30:00Z"); // 23:30 NZDT, Oct 3
    const pastMidnight = ms("2026-10-03T11:30:00Z"); // 00:30 NZDT, Oct 4
    expect(lateNight >= ms(day.since) && lateNight < ms(day.until)).toBe(true);
    expect(pastMidnight < ms(day.until)).toBe(false);
    expect(calendarDayIn(lateNight, "Pacific/Auckland")).toBe("2026-10-03");
    expect(calendarDayIn(pastMidnight, "Pacific/Auckland")).toBe("2026-10-04");
  });

  it("a spring-forward day is 23 hours (Europe/Paris, 2026-03-29)", () => {
    const r = activityDayRange("2026-03-29", "Europe/Paris");
    expect(r.since).toBe("2026-03-28T23:00:00.000Z");
    expect(r.until).toBe("2026-03-29T22:00:00.000Z");
    expect(ms(r.until) - ms(r.since)).toBe(23 * 3600_000);
  });

  it("a fall-back day is 25 hours (America/New_York, 2026-11-01)", () => {
    const r = activityDayRange("2026-11-01", "America/New_York");
    expect(ms(r.until) - ms(r.since)).toBe(25 * 3600_000);
  });

  it("a day whose midnight DST skips starts at the jump (America/Santiago, 2026-09-06)", () => {
    const r = activityDayRange("2026-09-06", "America/Santiago");
    // 00:00 -04 never happens: the clock reads 01:00 -03 at 04:00Z.
    expect(r.since).toBe("2026-09-06T04:00:00.000Z");
    expect(calendarDayIn(ms(r.since), "America/Santiago")).toBe("2026-09-06");
    expect(calendarDayIn(ms(r.since) - 1, "America/Santiago")).toBe(
      "2026-09-05"
    );
  });

  it("consecutive days tile with no gap and no overlap", () => {
    for (const tz of [
      "UTC",
      "Europe/Paris",
      "America/Santiago",
      "Asia/Kolkata",
    ]) {
      let d = "2026-03-20";
      for (let i = 0; i < 200; i++) {
        const next = new Date(ms(`${d}T12:00:00Z`) + 86_400_000)
          .toISOString()
          .slice(0, 10);
        expect(activityDayRange(d, tz).until).toBe(
          activityDayRange(next, tz).since
        );
        d = next;
      }
    }
  });

  it("today is the zone's calendar day, not UTC's", () => {
    const now = new Date("2026-10-03T23:30:00Z");
    expect(todayInTimeZone("UTC", now)).toBe("2026-10-03");
    expect(todayInTimeZone("Pacific/Auckland", now)).toBe("2026-10-04");
    expect(todayInTimeZone("America/Los_Angeles", now)).toBe("2026-10-03");
  });

  it("rejects an unknown zone", () => {
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("activityWindow", () => {
  it("clamps to 371 days and to at least one", () => {
    expect(activityWindow("2026-10-03", 9999).from).toBe("2025-09-28");
    expect(ACTIVITY_DAILY_MAX_DAYS).toBe(371);
    expect(activityWindow("2026-10-03", 0)).toEqual({
      from: "2026-10-03",
      to: "2026-10-03",
    });
  });
});

describe("levels — quantiles of the non-zero days (D3)", () => {
  it("zero is level 0, always", () => {
    expect(activityLevel(0, [1, 2, 3])).toBe(0);
    expect(activityThresholds([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("the busiest day is always level 4, even with few active days", () => {
    const t = activityThresholds([0, 1, 4, 12]);
    expect([1, 4, 12].map((c) => activityLevel(c, t))).toEqual([2, 3, 4]);
    // Every active day ties: all are the busiest.
    const flat = activityThresholds([0, 1, 0, 1, 1]);
    expect(activityLevel(1, flat)).toBe(4);
  });

  it("one 200-act day does not flatten the year (vs quartiles of max)", () => {
    const counts = [1, 2, 2, 3, 4, 5, 6, 200];
    const t = activityThresholds(counts);
    expect(t).toEqual([1, 3, 5]);
    expect(activityLevel(6, t)).toBe(4);
    expect(activityLevel(4, t)).toBe(3);
    expect(activityLevel(3, t)).toBe(2);
    expect(activityLevel(2, t)).toBe(2);
    expect(activityLevel(1, t)).toBe(1);
    expect(activityLevel(200, t)).toBe(4);
  });

  it("zero days do not drag the quantiles down", () => {
    expect(activityThresholds([0, 0, 0, 0, 0, 0, 10, 20, 30, 40])).toEqual([
      10, 20, 30,
    ]);
  });
});

describe("buildActivityHeat — the grid", () => {
  // 2026-10-03 is a Saturday.
  it("ends on `to`, newest week last, week starting Sunday", () => {
    const m = buildActivityHeat([], { to: "2026-10-03", weeks: 2 });
    expect(m.weeks).toBe(2);
    expect(m.cells).toHaveLength(14);
    expect(m.cells[0]).toMatchObject({
      date: "2026-09-20",
      week: 0,
      weekday: 0,
    });
    expect(m.cells[13]).toMatchObject({
      date: "2026-10-03",
      week: 1,
      weekday: 6,
    });
  });

  it("days after `to` in the last week are empty slots, not cells", () => {
    // 2026-10-01 is a Thursday: Fri + Sat of the last week are null.
    const m = buildActivityHeat([], { to: "2026-10-01", weeks: 1 });
    expect(m.cells.map((c) => c.date)).toEqual([
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
    expect(m.rows[5]![0]).toBeNull();
    expect(m.rows[6]![0]).toBeNull();
    expect(m.rows[4]![0]!.date).toBe("2026-10-01");
  });

  it("week starting Monday shifts the lead offset", () => {
    const m = buildActivityHeat([], {
      to: "2026-10-03",
      weeks: 1,
      weekStartsOn: 1,
    });
    expect(m.cells[0]!.date).toBe("2026-09-28");
    expect(m.cells[0]!.weekday).toBe(0);
  });

  it("missing days count 0; totals, active days and busiest day", () => {
    const m = buildActivityHeat(
      [
        { date: "2026-10-01", count: 3 },
        { date: "2026-10-03", count: 9 },
        { date: "2025-01-01", count: 500 }, // outside the grid: ignored
      ],
      { to: "2026-10-03", weeks: 1 }
    );
    expect(m.total).toBe(12);
    expect(m.activeDays).toBe(2);
    expect(m.busiest).toEqual({ date: "2026-10-03", count: 9 });
    expect(m.cells.find((c) => c.date === "2026-10-02")).toMatchObject({
      count: 0,
      level: 0,
    });
  });

  it("names each month once, in the week it starts", () => {
    const m = buildActivityHeat([], { to: "2026-10-03", weeks: 8 });
    expect(m.months.map((x) => x.month)).toEqual([7, 8, 9]);
    const oct = m.months.find((x) => x.month === 9)!;
    expect(m.cells.find((c) => c.date === "2026-10-01")!.week).toBe(oct.week);
  });

  it("clamps the window to 53 weeks", () => {
    expect(buildActivityHeat([], { to: "2026-10-03", weeks: 400 }).weeks).toBe(
      53
    );
  });
});

describe("words (D5: the unit is 'activity')", () => {
  it("counts", () => {
    expect(activityCountLabel(0)).toBe("No activity");
    expect(activityCountLabel(1)).toBe("1 activity");
    expect(activityCountLabel(1200)).toBe("1,200 activities");
  });

  it("a cell reads count + day, the day never shifted by the runtime zone", () => {
    expect(
      activityCellLabel({ date: "2026-10-03", count: 12 }, "short", "en-US")
    ).toBe("12 activities on Sat, Oct 3");
    expect(
      activityCellLabel({ date: "2026-10-03", count: 1 }, "long", "en-US")
    ).toBe("1 activity on Saturday, October 3, 2026");
  });

  it("summary", () => {
    expect(activityHeatSummary({ total: 0, activeDays: 0 })).toBe(
      "No activity"
    );
    expect(activityHeatSummary({ total: 14, activeDays: 1 })).toBe(
      "14 activities · active 1 day"
    );
  });
});

import { describe, it, expect } from "vitest";
import { isCronTimezone, nextCronRunAt } from "./cron.js";

const at = (iso: string) => new Date(iso);
const next = (expression: string, from: string, timezone?: string) =>
  nextCronRunAt(expression, at(from), timezone)?.toISOString() ?? null;

describe("nextCronRunAt — the zone a trigger names (ticket 592930c8)", () => {
  it("06:50 Europe/Paris is 05:50 UTC in winter", () => {
    expect(next("50 6 * * *", "2026-01-15T00:00:00Z", "Europe/Paris")).toBe(
      "2026-01-15T05:50:00.000Z"
    );
  });

  it("06:50 Europe/Paris is 04:50 UTC in summer", () => {
    expect(next("50 6 * * *", "2026-07-15T00:00:00Z", "Europe/Paris")).toBe(
      "2026-07-15T04:50:00.000Z"
    );
  });

  it("reads any zone, whatever the machine's own clock is", () => {
    // Neither UTC nor the zone a dev box or CI runner sits in: a parser that
    // read the process clock passes the Paris rows on a Paris machine.
    expect(next("50 6 * * *", "2026-01-15T00:00:00Z", "Asia/Kolkata")).toBe(
      "2026-01-15T01:20:00.000Z"
    );
    expect(next("50 6 * * *", "2026-01-15T00:00:00Z", "America/New_York")).toBe(
      "2026-01-15T11:50:00.000Z"
    );
  });

  it("crosses the spring DST change (29 March 2026) at the same local time", () => {
    // Saturday 06:00Z: 06:50 Paris (05:50Z) has passed; Sunday is summer time.
    expect(next("50 6 * * *", "2026-03-28T06:00:00Z", "Europe/Paris")).toBe(
      "2026-03-29T04:50:00.000Z"
    );
  });

  it("no zone, or an empty one, is UTC — every row written before zones were read keeps its hour", () => {
    expect(next("50 6 * * *", "2026-01-15T00:00:00Z")).toBe(
      "2026-01-15T06:50:00.000Z"
    );
    expect(next("50 6 * * *", "2026-01-15T00:00:00Z", "")).toBe(
      "2026-01-15T06:50:00.000Z"
    );
    expect(next("50 6 * * *", "2026-01-15T00:00:00Z", "UTC")).toBe(
      "2026-01-15T06:50:00.000Z"
    );
  });

  it("is strictly after `from`: a slot that is now is the next one", () => {
    expect(next("50 6 * * *", "2026-01-15T06:50:00Z")).toBe(
      "2026-01-16T06:50:00.000Z"
    );
  });
});

describe("nextCronRunAt — standard cron fields", () => {
  it("day-of-month and day-of-week both set match EITHER (the 1st, or a Monday)", () => {
    // Tuesday 30 June 2026: the 1st (Wednesday 1 July) comes before Monday
    // 6 July. Matching BOTH would wait for a 1st that is a Monday.
    expect(next("0 9 1 * 1", "2026-06-30T00:00:00Z")).toBe(
      "2026-07-01T09:00:00.000Z"
    );
    // Thursday 2 July: the next Monday comes before the next 1st.
    expect(next("0 9 1 * 1", "2026-07-02T00:00:00Z")).toBe(
      "2026-07-06T09:00:00.000Z"
    );
  });

  it("reads a stepped range a-b/N", () => {
    // 09, 13, 17.
    expect(next("0 9-17/4 * * *", "2026-01-15T10:00:00Z")).toBe(
      "2026-01-15T13:00:00.000Z"
    );
    expect(next("0 9-17/4 * * *", "2026-01-15T17:30:00Z")).toBe(
      "2026-01-16T09:00:00.000Z"
    );
  });

  it("reads day names and */N", () => {
    expect(next("0 9 * * MON", "2026-01-15T00:00:00Z")).toBe(
      "2026-01-19T09:00:00.000Z"
    );
    expect(next("*/15 * * * *", "2026-01-15T10:07:00Z")).toBe(
      "2026-01-15T10:15:00.000Z"
    );
  });

  it("cannot schedule what is not five fields, not cron, or in an unknown zone", () => {
    expect(next("0 0 9 * * *", "2026-01-15T00:00:00Z")).toBeNull();
    expect(next("@daily", "2026-01-15T00:00:00Z")).toBeNull();
    expect(next("not a cron", "2026-01-15T00:00:00Z")).toBeNull();
    expect(next("61 9 * * *", "2026-01-15T00:00:00Z")).toBeNull();
    expect(
      next("50 6 * * *", "2026-01-15T00:00:00Z", "Mars/Olympus")
    ).toBeNull();
  });
});

describe("isCronTimezone", () => {
  it("knows IANA names and UTC, and refuses what the clock cannot read", () => {
    expect(isCronTimezone("Europe/Paris")).toBe(true);
    expect(isCronTimezone("America/New_York")).toBe(true);
    expect(isCronTimezone("UTC")).toBe(true);
    expect(isCronTimezone("Mars/Olympus")).toBe(false);
    expect(isCronTimezone("Paris")).toBe(false);
    // The worker's own clock is the zone nobody chose.
    expect(isCronTimezone("local")).toBe(false);
    expect(isCronTimezone("system")).toBe(false);
  });
});

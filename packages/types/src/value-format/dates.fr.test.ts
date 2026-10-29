/**
 * The French date tables (plan 915cc937 P3; research 7b8070fd §2.4). The
 * English ladder is pinned by `dates.test.ts`, unchanged; these vectors pin
 * the French one, and the default stays English.
 *
 * A unit symbol is held to its number by a no-break space (U+00A0), so the
 * vectors write it as `\u00a0`: "il y a 5 min" never breaks before "min".
 */
import { describe, expect, it } from "vitest";
import {
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

const NOW = new Date("2026-09-04T12:00:00.000Z").getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ahead = (ms: number) => new Date(NOW + ms).toISOString();
const fr = { locale: "fr" } as const;

describe("formatRelative in French — the backward ladder", () => {
  it.each([
    [0, "à l’instant"],
    [59 * SECOND, "à l’instant"],
    [5 * MINUTE, "il y a 5\u00a0min"],
    [2 * HOUR, "il y a 2\u00a0h"],
    [DAY, "hier"],
    [3 * DAY, "il y a 3\u00a0j"],
    [7 * DAY, "il y a 1 semaine"],
    [14 * DAY, "il y a 2 semaines"],
  ])("%dms ago → %s", (elapsed, expected) => {
    expect(formatRelative(ago(elapsed), NOW, fr)).toBe(expected);
  });

  it("hands off to « 5 mars » at four weeks, with the year once it differs", () => {
    expect(formatRelative(ago(28 * DAY), NOW, fr)).toBe("7 août");
    expect(formatRelative("2025-03-05T09:00:00.000Z", NOW, fr)).toBe(
      "5 mars 2025"
    );
  });

  it("no locale is English: the default does not move", () => {
    expect(formatRelative(ago(2 * HOUR), NOW)).toBe("2h ago");
    expect(formatRelative(ago(2 * HOUR), NOW, { locale: "en" })).toBe("2h ago");
  });
});

describe("formatUntil / formatFromNow in French", () => {
  it("the forward ladder", () => {
    expect(formatUntil(ahead(30 * SECOND), NOW, fr)).toBe("maintenant");
    expect(formatUntil(ahead(5 * MINUTE), NOW, fr)).toBe("dans 5\u00a0min");
    expect(formatUntil(ahead(DAY), NOW, fr)).toBe("demain");
    expect(formatUntil(ahead(3 * DAY), NOW, fr)).toBe("dans 3\u00a0j");
    expect(formatUntil(ahead(14 * DAY), NOW, fr)).toBe("dans 2 semaines");
    expect(formatUntil(ahead(40 * DAY), NOW, fr)).toBe("14 oct.");
  });

  it("a date-only value counts calendar days", () => {
    const noon = new Date(2026, 8, 4, 12).getTime();
    expect(formatFromNow("2026-09-04", noon, fr)).toBe("aujourd’hui");
    expect(formatFromNow("2026-09-05", noon, fr)).toBe("demain");
    expect(formatFromNow("2026-09-03", noon, fr)).toBe("hier");
    expect(formatFromNow("2026-09-07", noon, fr)).toBe("dans 3\u00a0j");
    expect(formatFromNow("2026-09-01", noon, fr)).toBe("il y a 3\u00a0j");
    expect(formatFromNow("2026-09-18", noon, fr)).toBe("dans 2 semaines");
    expect(formatFromNow("2026-12-25", noon, fr)).toBe("25 déc.");
  });
});

describe("absolute dates, months and weekdays in French", () => {
  it("day, then the short month; a dot only on the cut forms", () => {
    const shortMonths = Array.from({ length: 12 }, (_, m) =>
      formatMonthShort(new Date(2026, m, 15), fr)
    );
    expect(shortMonths).toEqual([
      "janv.",
      "févr.",
      "mars",
      "avr.",
      "mai",
      "juin",
      "juil.",
      "août",
      "sept.",
      "oct.",
      "nov.",
      "déc.",
    ]);
    expect(formatAbsoluteDate("2026-03-05T09:00:00.000Z", NOW, fr)).toBe(
      "5 mars"
    );
    expect(formatAbsoluteDate("2025-03-05T09:00:00.000Z", NOW, fr)).toBe(
      "5 mars 2025"
    );
  });

  it("the 24-hour clock, the same as English (D5)", () => {
    expect(formatTime(new Date(2026, 9, 15, 14, 5), fr)).toBe("14:05");
    expect(formatDateTime(new Date(2026, 9, 15, 14, 5), NOW, fr)).toBe(
      "15 oct. · 14:05"
    );
  });

  it("weekdays and long forms, lower case", () => {
    const fri = new Date(2026, 8, 4, 9);
    expect(formatDayEyebrow(fri, fr)).toBe("vendredi 4 septembre");
    expect(formatDayLong(fri, fr)).toBe("vendredi 4 septembre 2026");
    expect(formatMonthYear(fri, fr)).toBe("septembre 2026");
    expect(formatWeekday(fri, "narrow", fr)).toBe("V");
    expect(formatWeekday(fri, "short", fr)).toBe("ven.");
    expect(formatWeekday(fri, "long", fr)).toBe("vendredi");
  });
});

describe("formatElapsed in French", () => {
  it.each([
    [0, "<1\u00a0min"],
    [12 * MINUTE, "12\u00a0min"],
    [2 * HOUR, "2\u00a0h"],
    [2 * HOUR + 5 * MINUTE, "2\u00a0h 5\u00a0min"],
    [3 * DAY, "3\u00a0j"],
  ])("%i ms in the state reads %s", (elapsed, expected) => {
    expect(formatElapsed(ago(elapsed), NOW, fr)).toBe(expected);
  });
});

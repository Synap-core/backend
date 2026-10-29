/**
 * The ONE door for how a date, a time and an elapsed duration read — on the
 * desk (web, browser) and the phone (relay) alike, in each locale Synap ships.
 *
 * Value formatting is deliberately outside the vocabulary
 * (`.claude/rules/vocabulary.md`: "dates, relative time… their own home"). This
 * module is that home. Before it, the desk printed "Jan 5, 2026" and Intl's
 * "2 hours ago" while the phone printed "5 Mar" and "2h ago" for the same
 * instant, and one page could show "15/10/2026, 13:55:41" beside "3 Oct · 19:56".
 *
 * Every form is spelled here rather than asked of `toLocaleDateString` /
 * `Intl.RelativeTimeFormat`: those answer by the device's locale (day/month
 * order, a 12-hour clock), differ between engines (ICU's "Sept" vs "Sep") and
 * are partial on Hermes. A person must read one date the same way on both
 * screens. The French words are tables below, CLDR's forms; the clock is
 * 24-hour in both ("14:05").
 *
 * Pure and dependency-free apart from the shared date-placement rule and the
 * locale and plural rules, so it is safe in the pod, the browser, Electron,
 * React Native and Node.
 */

import { isDateOnlyShaped, parseEntityDate } from "../dates/index.js";
import type { Locale } from "../i18n/locale.js";
import { pluralCategory } from "../i18n/plural.js";
import { formatLocale, type ValueFormatOptions } from "./locale.js";
import { DURATION_UNITS, formatNumber } from "./numbers.js";

/** A value any of the formatters accept: an ISO string, a `Date` or epoch ms. */
export type DateInput = string | number | Date | null | undefined;

/** The words one locale writes dates with. */
interface DateWords {
  monthsShort: readonly string[];
  monthsLong: readonly string[];
  /** Sunday first, as `Date.getDay()`. */
  weekdaysLong: readonly string[];
  weekdaysShort: readonly string[];
  weekdaysNarrow: readonly string[];
  justNow: string;
  now: string;
  today: string;
  tomorrow: string;
  yesterday: string;
  /** A span in the past: "5m ago". */
  ago: (span: string) => string;
  /** A span ahead: "in 5m". */
  ahead: (span: string) => string;
  /** "1 week", "2 weeks". */
  weeks: (n: number) => string;
}

const EN: DateWords = {
  monthsShort: [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ],
  monthsLong: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  weekdaysLong: [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ],
  weekdaysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  weekdaysNarrow: ["S", "M", "T", "W", "T", "F", "S"],
  justNow: "just now",
  now: "now",
  today: "today",
  tomorrow: "tomorrow",
  yesterday: "Yesterday",
  ago: (span) => `${span} ago`,
  ahead: (span) => `in ${span}`,
  weeks: (n) => `${n} ${pluralCategory("en", n) === "one" ? "week" : "weeks"}`,
};

/**
 * French, CLDR's forms. Month and weekday names are lower case. The short
 * month takes a dot only where it is cut: the closed list janv. févr. avr.
 * juil. sept. oct. nov. déc. ("mars", "mai", "juin", "août" are whole).
 */
const FR: DateWords = {
  monthsShort: [
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
  ],
  monthsLong: [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
  ],
  weekdaysLong: [
    "dimanche",
    "lundi",
    "mardi",
    "mercredi",
    "jeudi",
    "vendredi",
    "samedi",
  ],
  weekdaysShort: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
  weekdaysNarrow: ["D", "L", "M", "M", "J", "V", "S"],
  justNow: "à l’instant",
  now: "maintenant",
  today: "aujourd’hui",
  tomorrow: "demain",
  yesterday: "hier",
  ago: (span) => `il y a ${span}`,
  ahead: (span) => `dans ${span}`,
  weeks: (n) =>
    `${n} ${pluralCategory("fr", n) === "one" ? "semaine" : "semaines"}`,
};

const WORDS: Readonly<Record<Locale, DateWords>> = { en: EN, fr: FR };

const SECOND_MS = 1000;
const DAY_MS = 86_400_000;

/**
 * A date-only value ("2026-07-25", a `dueDate`) lands on its author's LOCAL
 * day, through the same placement rule the calendar and the ICS feed use, so
 * a due date never reads a day early west of UTC.
 */
function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  return parseEntityDate(value);
}

/** "5m", "2h", "3d" ("5 min", "2 h", "3 j"): a count and its unit symbol. */
function span(n: number, unit: "min" | "h" | "d", locale: Locale): string {
  return `${formatNumber(n, { locale })}${DURATION_UNITS[locale][unit]}`;
}

/**
 * How long ago `value` was — the backward ladder, shortest form that is still
 * unambiguous:
 *
 *   < 60s      just now                  à l’instant
 *   < 60m      Nm ago                    il y a N min
 *   < 24h      Nh ago                    il y a N h
 *   = 1 day    Yesterday                 hier
 *   < 7d       Nd ago                    il y a N j
 *   < 4 weeks  N week(s) ago             il y a N semaine(s)
 *   older      5 Mar / 5 Mar 2025        5 mars / 5 mars 2025  ← formatAbsoluteDate
 *
 * Elapsed, not calendar: "Yesterday" means 24–48h elapsed, because calendar
 * arithmetic needs a timezone the apps never establish, and within hours of
 * midnight "18h ago" is the better string anyway.
 *
 * A future instant reads "just now", never "-3m ago": a stamp that is supposed
 * to be past and sits ahead of the device clock is clock skew. For a value that
 * is supposed to be ahead (a due date, a schedule) use {@link formatUntil} or
 * {@link formatFromNow}.
 *
 * '' for a missing or unparseable value, so a caller can omit the slot.
 */
export function formatRelative(
  value: DateInput,
  now: number = Date.now(),
  options?: ValueFormatOptions
): string {
  const date = toDate(value);
  if (!date) return "";
  const locale = formatLocale(options);
  const words = WORDS[locale];

  const seconds = Math.floor((now - date.getTime()) / SECOND_MS);
  if (seconds < 60) return words.justNow;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return words.ago(span(minutes, "min", locale));

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return words.ago(span(hours, "h", locale));

  const days = Math.floor(hours / 24);
  if (days === 1) return words.yesterday;
  if (days < 7) return words.ago(span(days, "d", locale));

  const weeks = Math.floor(days / 7);
  if (weeks < 4) return words.ago(words.weeks(weeks));

  return formatAbsoluteDate(date, now, { locale });
}

/**
 * How long until `value` — {@link formatRelative}'s mirror, for an instant
 * that is supposed to be ahead. It cannot be `formatRelative` with a flag: that
 * one floors the future at "just now" on purpose, which would say a session
 * scheduled for Friday has already happened.
 *
 *   arrived      now               maintenant   ← never a negative duration
 *   < 60m        in Nm             dans N min
 *   < 24h        in Nh             dans N h
 *   = 1 day      tomorrow          demain
 *   < 7d         in Nd             dans N j
 *   < 4 weeks    in N week(s)      dans N semaine(s)
 *   further out  5 Mar / 5 Mar 2027
 */
export function formatUntil(
  value: DateInput,
  now: number = Date.now(),
  options?: ValueFormatOptions
): string {
  const date = toDate(value);
  if (!date) return "";
  const locale = formatLocale(options);
  const words = WORDS[locale];

  const seconds = Math.floor((date.getTime() - now) / SECOND_MS);
  // A scheduled instant that has arrived IS now; without knowing why it has
  // not started, that is the only honest thing to say.
  if (seconds < 60) return words.now;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return words.ahead(span(minutes, "min", locale));

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return words.ahead(span(hours, "h", locale));

  const days = Math.floor(hours / 24);
  if (days === 1) return words.tomorrow;
  if (days < 7) return words.ahead(span(days, "d", locale));

  const weeks = Math.floor(days / 7);
  if (weeks < 4) return words.ahead(words.weeks(weeks));

  return formatAbsoluteDate(date, now, { locale });
}

/**
 * Either direction, for a value that may lie on either side of now (a due
 * date that may be overdue): ahead by more than a minute reads
 * {@link formatUntil}, anything else {@link formatRelative}. The minute of
 * slack keeps clock skew on a past stamp from reading "in 1m".
 *
 * A date-only value names a DAY, not an instant, so it counts calendar days:
 * a task due today reads "today" ("aujourd’hui") all day, never "15h ago"
 * from its midnight.
 */
export function formatFromNow(
  value: DateInput,
  now: number = Date.now(),
  options?: ValueFormatOptions
): string {
  const date = toDate(value);
  if (!date) return "";
  const locale = formatLocale(options);
  if (
    value !== null &&
    value !== undefined &&
    typeof value !== "number" &&
    isDateOnlyShaped(value)
  ) {
    return formatDayFromNow(date, now, locale);
  }
  return date.getTime() - now >= 60 * SECOND_MS
    ? formatUntil(date, now, { locale })
    : formatRelative(date, now, { locale });
}

function formatDayFromNow(day: Date, now: number, locale: Locale): string {
  const words = WORDS[locale];
  const today = new Date(now);
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime();
  const startOfDay = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate()
  ).getTime();
  // Rounded, not floored: a daylight-saving day is 23 or 25 hours long.
  const days = Math.round((startOfDay - startOfToday) / DAY_MS);
  if (days === 0) return words.today;
  if (days === 1) return words.tomorrow;
  if (days === -1) return words.yesterday;
  const count = Math.abs(days);
  const direction = days > 0 ? words.ahead : words.ago;
  if (count < 7) return direction(span(count, "d", locale));
  const weeks = Math.floor(count / 7);
  if (weeks < 4) return direction(words.weeks(weeks));
  return formatAbsoluteDate(day, now, { locale });
}

/**
 * The ONE absolute date form: `5 Mar` (`5 mars`), or `5 Mar 2025` when the
 * year is not `now`'s. Day before a month word — never a numeric `05/03`,
 * whose order depends on who reads it. This year's year is noise; another
 * year's is the fact.
 */
export function formatAbsoluteDate(
  value: DateInput,
  now: number = Date.now(),
  options?: ValueFormatOptions
): string {
  const date = toDate(value);
  if (!date) return "";
  const words = WORDS[formatLocale(options)];
  const dayMonth = `${date.getDate()} ${words.monthsShort[date.getMonth()]}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? dayMonth
    : `${dayMonth} ${date.getFullYear()}`;
}

/**
 * A clock time on the 24-hour clock: `13:55`, or `13:55:41` with `seconds`
 * (a live clock face). Never a 12-hour `1:55 PM`. The same in every locale
 * (French writes "14:05" too, plan 915cc937 D5), so `locale` is accepted and
 * changes nothing.
 */
export function formatTime(
  value: DateInput,
  options: { seconds?: boolean } & ValueFormatOptions = {}
): string {
  const date = toDate(value);
  if (!date) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return options.seconds ? `${hm}:${pad(date.getSeconds())}` : hm;
}

/** A date with its time: `5 Mar · 13:55` — the two forms above, joined. */
export function formatDateTime(
  value: DateInput,
  now: number = Date.now(),
  options?: ValueFormatOptions
): string {
  const day = formatAbsoluteDate(value, now, options);
  return day ? `${day} · ${formatTime(value)}` : "";
}

/** A month as a calendar tile shows it: `Oct` (`oct.`). */
export function formatMonthShort(
  value: DateInput,
  options?: ValueFormatOptions
): string {
  const date = toDate(value);
  return date ? WORDS[formatLocale(options)].monthsShort[date.getMonth()]! : "";
}

/** A month heading: `October 2026` (`octobre 2026`). */
export function formatMonthYear(
  value: DateInput,
  options?: ValueFormatOptions
): string {
  const date = toDate(value);
  if (!date) return "";
  const month = WORDS[formatLocale(options)].monthsLong[date.getMonth()];
  return `${month} ${date.getFullYear()}`;
}

/**
 * A weekday: `M` (a column head), `Mon` (a forecast or agenda column) or
 * `Monday` — `L`, `lun.`, `lundi` in French.
 */
export function formatWeekday(
  value: DateInput,
  width: "narrow" | "short" | "long" = "narrow",
  options?: ValueFormatOptions
): string {
  const date = toDate(value);
  if (!date) return "";
  const words = WORDS[formatLocale(options)];
  const names =
    width === "long"
      ? words.weekdaysLong
      : width === "short"
        ? words.weekdaysShort
        : words.weekdaysNarrow;
  return names[date.getDay()]!;
}

/**
 * A day eyebrow: `Friday 5 September` (`vendredi 5 septembre`) — a page that
 * heads with the day being looked at, where the weekday is the point. Not a
 * row date (that is {@link formatAbsoluteDate}); never the year.
 */
export function formatDayEyebrow(
  value: DateInput = new Date(),
  options?: ValueFormatOptions
): string {
  const date = toDate(value);
  if (!date) return "";
  const words = WORDS[formatLocale(options)];
  return `${words.weekdaysLong[date.getDay()]} ${date.getDate()} ${words.monthsLong[date.getMonth()]}`;
}

/**
 * A whole day spoken in full: `Friday 17 October 2026` (`vendredi 17 octobre
 * 2026`) — an accessible name or a tooltip, where nothing may be left implied.
 */
export function formatDayLong(
  value: DateInput,
  options?: ValueFormatOptions
): string {
  const date = toDate(value);
  if (!date) return "";
  return `${formatDayEyebrow(date, options)} ${date.getFullYear()}`;
}

/**
 * Whole days from `now` until `value`; NEGATIVE once it has passed. Floors, so
 * a review date 12 hours away is `0` (today, still ahead) and one 12 hours past
 * is `-1`. A caller asking "has this expired?" compares the instant, not this.
 *
 * `null` for a missing or unparseable value, so "no date" is never read as
 * "due today".
 */
export function daysUntil(
  value: DateInput,
  now: number = Date.now()
): number | null {
  const date = toDate(value);
  if (!date) return null;
  return Math.floor((date.getTime() - now) / DAY_MS);
}

/**
 * How long something has been in its state — the ELAPSED clock a state pill
 * carries beside its word ("Working 12m", "Needs you 2h 5m"; AffectUI's agent
 * inbox foot). Not {@link formatRelative}: that dates an event ("2h ago"),
 * this measures a span that is still running, so it has no "ago" and no
 * calendar form.
 *
 *   < 60s      <1m        <1 min   ← a surface ticks per minute, never per second
 *   < 60m      Nm         N min
 *   < 24h      Nh Nm      N h N min  ← "Nh" when the minutes are 0
 *   otherwise  Nd         N j
 *
 * A start ahead of the clock (skew) reads "<1m", never a negative span.
 * '' for a missing or unparseable value, so a caller can omit the slot.
 */
export function formatElapsed(
  since: DateInput,
  now: number = Date.now(),
  options?: ValueFormatOptions
): string {
  const date = toDate(since);
  if (!date) return "";
  const locale = formatLocale(options);
  const minutes = Math.floor((now - date.getTime()) / (60 * SECOND_MS));
  if (minutes < 1) return `<${span(1, "min", locale)}`;
  if (minutes < 60) return span(minutes, "min", locale);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0
      ? span(hours, "h", locale)
      : `${span(hours, "h", locale)} ${span(minutes % 60, "min", locale)}`;
  }
  return span(Math.floor(hours / 24), "d", locale);
}

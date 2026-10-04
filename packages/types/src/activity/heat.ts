/**
 * ACTIVITY HEAT — "how alive is it?" as ONE pure rule, every surface.
 *
 * The pod's `activity.daily` door counts the SAME ledger `activity.list` pages
 * (proposals, decisions, runs, session lifecycles), per day in the VIEWER's
 * time zone. This module owns everything both apps would otherwise re-derive:
 *
 *   - which instants a day spans in a time zone (`activityDayRange`), so a
 *     cell's count and the list its click opens cover exactly the same acts;
 *   - the grid (weeks × weekdays, newest week last) and its month marks;
 *   - the colour LEVEL of a count (0 = nothing, 1–4 = quantiles of the
 *     non-zero days — decision D3, 2026-10-04);
 *   - the words ("12 activities on Thu, Oct 3") — the unit is "activity"
 *     (decision D5, 2026-10-04).
 *
 * It returns levels, never colours: each surface maps a level to its own ramp.
 * Pure and dependency-free (only `Intl`), so it runs in the pod, Electron and
 * React Native alike.
 */

/** The widest window the door reads: 53 weeks × 7 days. */
export const ACTIVITY_DAILY_MAX_DAYS = 371;

/** One counted day. `date` is the viewer's calendar day, `YYYY-MM-DD`. */
export interface ActivityDay {
  date: string;
  count: number;
}

/** `activity.daily`'s answer. Sparse: a day with no act is absent. */
export interface ActivityDaily {
  /** First day of the window (inclusive), `YYYY-MM-DD` in `tz`. */
  from: string;
  /** Last day of the window (inclusive) — the viewer's today. */
  to: string;
  tz: string;
  days: ActivityDay[];
}

// ── Calendar days (UTC arithmetic on `YYYY-MM-DD`, no time zone involved) ───

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`not a calendar day: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

function dateOfDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** `date` moved by `delta` calendar days. */
export function addCalendarDays(date: string, delta: number): string {
  return dateOfDayNumber(dayNumber(date) + delta);
}

/** 0 = Sunday … 6 = Saturday. */
function weekdayOf(date: string): number {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay();
}

// ── Time zones ──────────────────────────────────────────────────────────────

/** `true` when the runtime knows `tz` as an IANA zone name. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock reading of instant `ms` in `tz`, as UTC-epoch ms. */
function wallMs(ms: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of wallClock(tz).formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

/** The calendar day instant `ms` falls on in `tz`. */
export function calendarDayIn(ms: number, tz: string): string {
  return new Date(wallMs(ms, tz)).toISOString().slice(0, 10);
}

/** The viewer's today in `tz`. */
export function todayInTimeZone(tz: string, now: Date = new Date()): string {
  return calendarDayIn(now.getTime(), tz);
}

/**
 * The FIRST instant whose calendar day in `tz` is `date`. Usually local
 * midnight; on a day whose midnight a DST jump skips (America/Santiago) it is
 * the transition instant; on a day whose midnight repeats it is the moment the
 * date turns. Bucketing an instant with SQL `at time zone` agrees with it.
 */
function dayStartMs(date: string, tz: string): number {
  const guess = dayNumber(date) * DAY_MS;
  const offsets = new Set(
    [guess - DAY_MS, guess, guess + DAY_MS].map((t) => wallMs(t, tz) - t)
  );
  let best = Number.POSITIVE_INFINITY;
  for (const off of offsets) {
    const t = guess - off;
    if (calendarDayIn(t, tz) === date && t < best) best = t;
  }
  if (!Number.isFinite(best)) {
    throw new RangeError(`no instant starts ${date} in ${tz}`);
  }
  return best;
}

/**
 * The half-open instant range `[since, until)` of calendar day `date` in
 * `tz` — what a day cell counted, and so what its click must list.
 */
export function activityDayRange(
  date: string,
  tz: string
): { since: string; until: string } {
  return {
    since: new Date(dayStartMs(date, tz)).toISOString(),
    until: new Date(dayStartMs(addCalendarDays(date, 1), tz)).toISOString(),
  };
}

/** The window of `days` calendar days ending on `to` (inclusive). */
export function activityWindow(
  to: string,
  days: number
): { from: string; to: string } {
  const n = Math.max(1, Math.min(Math.floor(days), ACTIVITY_DAILY_MAX_DAYS));
  return { from: addCalendarDays(to, -(n - 1)), to };
}

// ── Levels (D3: quantiles of the NON-ZERO days) ─────────────────────────────

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;
export const ACTIVITY_LEVELS: readonly ActivityLevel[] = [0, 1, 2, 3, 4];

/**
 * The upper bounds of levels 1, 2 and 3: the 25th / 50th / 75th percentile
 * (nearest rank) of the days that had ANY act. Anything above the third is
 * level 4. Quantiles, not fractions of the max: one 200-act import day must
 * not flatten every ordinary day of the year into the palest step.
 */
export function activityThresholds(
  counts: readonly number[]
): [number, number, number] {
  const active = counts.filter((c) => c > 0).sort((a, b) => a - b);
  if (active.length === 0) return [0, 0, 0];
  const at = (q: number) =>
    active[Math.min(active.length - 1, Math.ceil(q * active.length) - 1)]!;
  return [at(0.25), at(0.5), at(0.75)];
}

export function activityLevel(
  count: number,
  thresholds: readonly [number, number, number]
): ActivityLevel {
  if (!(count > 0)) return 0;
  if (count <= thresholds[0]) return 1;
  if (count <= thresholds[1]) return 2;
  if (count <= thresholds[2]) return 3;
  return 4;
}

// ── The grid ────────────────────────────────────────────────────────────────

export interface ActivityHeatCell {
  date: string;
  count: number;
  level: ActivityLevel;
  /** Column, 0 = oldest week. */
  week: number;
  /** Row, 0 = the first day of the week (`weekStartsOn`). */
  weekday: number;
}

export interface ActivityHeatModel {
  /** Every day of the grid, oldest first. Days after `to` are not cells. */
  cells: ActivityHeatCell[];
  /** `rows[weekday][week]` — the same cells, as the grid lays them out. */
  rows: Array<Array<ActivityHeatCell | null>>;
  weeks: number;
  /** The first week in which each month starts (for the month marks). */
  months: Array<{ week: number; month: number; year: number }>;
  thresholds: [number, number, number];
  total: number;
  /** Days with at least one act. */
  activeDays: number;
  busiest: ActivityDay | null;
}

/**
 * The grid of the `weeks` weeks ending with the week that holds `to`. Days
 * absent from `days` count 0; days outside the grid are ignored.
 */
export function buildActivityHeat(
  days: readonly ActivityDay[],
  opts: { to: string; weeks: number; weekStartsOn?: 0 | 1 }
): ActivityHeatModel {
  const weeks = Math.max(1, Math.min(Math.floor(opts.weeks), 53));
  const weekStartsOn = opts.weekStartsOn ?? 0;
  const lead = (weekdayOf(opts.to) - weekStartsOn + 7) % 7;
  const start = addCalendarDays(opts.to, -lead - (weeks - 1) * 7);
  const end = dayNumber(opts.to);

  const byDate = new Map<string, number>();
  for (const d of days) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.count);

  const raw: Array<Omit<ActivityHeatCell, "level">> = [];
  for (let n = dayNumber(start), i = 0; n <= end; n++, i++) {
    const date = dateOfDayNumber(n);
    raw.push({
      date,
      count: byDate.get(date) ?? 0,
      week: Math.floor(i / 7),
      weekday: i % 7,
    });
  }
  const thresholds = activityThresholds(raw.map((c) => c.count));
  const cells = raw.map((c) => ({
    ...c,
    level: activityLevel(c.count, thresholds),
  }));

  const rows: Array<Array<ActivityHeatCell | null>> = Array.from(
    { length: 7 },
    () => Array.from({ length: weeks }, () => null)
  );
  for (const c of cells) rows[c.weekday]![c.week] = c;

  const months: ActivityHeatModel["months"] = [];
  for (const c of cells) {
    if (c.date.endsWith("-01") || c === cells[0]) {
      const [y, m] = c.date.split("-").map(Number);
      const prev = months[months.length - 1];
      // Two month starts in one column: the later one names it.
      if (prev && prev.week === c.week) months.pop();
      months.push({ week: c.week, month: m! - 1, year: y! });
    }
  }

  let total = 0;
  let activeDays = 0;
  let busiest: ActivityDay | null = null;
  for (const c of cells) {
    total += c.count;
    if (c.count > 0) activeDays += 1;
    if (c.count > 0 && (!busiest || c.count > busiest.count)) {
      busiest = { date: c.date, count: c.count };
    }
  }
  return { cells, rows, weeks, months, thresholds, total, activeDays, busiest };
}

// ── Words (D5: the unit is "activity") ──────────────────────────────────────

/** "1 activity", "12 activities", "No activity". */
export function activityCountLabel(n: number): string {
  if (n === 0) return "No activity";
  return `${n.toLocaleString("en-US")} ${n === 1 ? "activity" : "activities"}`;
}

/** A calendar day as words, e.g. "Thu, Oct 3" (`long`: "Thursday, October 3, 2026"). */
export function activityDayWords(
  date: string,
  style: "short" | "long" = "short",
  locale?: string
): string {
  // Noon UTC of the day, formatted IN UTC: the calendar day never shifts.
  const at = new Date(dayNumber(date) * DAY_MS + DAY_MS / 2);
  return at.toLocaleDateString(locale, {
    timeZone: "UTC",
    weekday: style,
    month: style,
    day: "numeric",
    ...(style === "long" ? { year: "numeric" as const } : {}),
  });
}

/** A cell's one-line reading: "12 activities on Thu, Oct 3". */
export function activityCellLabel(
  cell: Pick<ActivityDay, "date" | "count">,
  style: "short" | "long" = "short",
  locale?: string
): string {
  return `${activityCountLabel(cell.count)} on ${activityDayWords(cell.date, style, locale)}`;
}

/** A month mark's word, e.g. "Oct". */
export function activityMonthWord(
  month: number,
  year: number,
  locale?: string
): string {
  return new Date(Date.UTC(year, month, 15)).toLocaleDateString(locale, {
    timeZone: "UTC",
    month: "short",
  });
}

/** The section's summary mark: "214 activities · active 61 days". */
export function activityHeatSummary(
  model: Pick<ActivityHeatModel, "total" | "activeDays">
): string {
  if (model.total === 0) return activityCountLabel(0);
  return `${activityCountLabel(model.total)} · active ${model.activeDays} ${
    model.activeDays === 1 ? "day" : "days"
  }`;
}

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
 * The grid returns levels, never colours. The level → colour RECIPE is one
 * shared constant (`ACTIVITY_RAMP`): the web writes it as CSS `color-mix`,
 * relay resolves it to hex (`resolveActivityRamp`); both are checked against
 * the dataviz ordinal floors (`checkActivityRamp`). A day's door carries its
 * SCOPE in the address (`ActivityScope`), never in the global project lens.
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

import { resolveObjectNoun } from "../vocabulary/index.js";

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

/**
 * The viewer's IANA zone — the ONE derivation every heat read and every day
 * door uses, so a cell's count and the list it opens bucket the same day.
 * `UTC` only when the runtime reports none.
 */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
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
 * The upper bounds of levels 1, 2 and 3, from the days that had ANY act: a
 * count's level is `ceil(4 × F)`, where F is the share of active days at or
 * below it (the empirical quantile). So the busiest day is always level 4,
 * and a quarter of the active days sit at each step. Quantiles, not fractions
 * of the max: one 200-act import day must not flatten every ordinary day of
 * the year into the palest step. `0` = no active day falls in that quarter.
 */
export function activityThresholds(
  counts: readonly number[]
): [number, number, number] {
  const active = counts.filter((c) => c > 0).sort((a, b) => a - b);
  const n = active.length;
  // The largest active count whose share-at-or-below is within `q`.
  const upTo = (q: number) => {
    let t = 0;
    for (let i = 0; i < n; i++) {
      const v = active[i]!;
      if (i + 1 < n && active[i + 1] === v) continue; // last of a tie run
      if ((i + 1) / n <= q) t = v;
    }
    return t;
  };
  return [upTo(0.25), upTo(0.5), upTo(0.75)];
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

/**
 * The fewest columns between two month marks. A mark ("Sept", ~22–30px) is
 * wider than a column (10–16px + gap), so marks one or two columns apart
 * collide; three columns is ≥ 39px at the smallest cell.
 */
export const ACTIVITY_MONTH_MIN_WEEKS = 3;

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
      // A month mark is wider than a column: two marks closer than
      // `ACTIVITY_MONTH_MIN_WEEKS` columns would print over each other
      // ("AprMay"). The later one names the stretch. Month starts are ≥ 4
      // weeks apart, so only the window's leading partial month ever drops.
      if (prev && c.week - prev.week < ACTIVITY_MONTH_MIN_WEEKS) months.pop();
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

/**
 * The section's name. It counts WORK — proposals, decisions, runs and session
 * lifecycles (the `activity.list` ledger) — not captures or edits, so it does
 * not claim the whole pod's life (decision 2026-10-04).
 */
export const ACTIVITY_HEAT_TITLE = `${resolveObjectNoun("work")} activity`;

// ── Scope (what a cell counted travels with its door) ───────────────────────

/**
 * WHERE a heat counted: the whole floor, one space, one project, one track or
 * one session. A day's door carries it in the ADDRESS, so the list it opens
 * reads exactly what the cell counted — never by writing the viewer's global
 * project lens. It is ALSO the lens scope's address (`encodeLensScope`), so a
 * lens page's "Show all" and a heat cell spell one scope ONE way and Work
 * reads it with ONE reader.
 */
export type ActivityScope =
  | { kind: "pod" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "project"; projectId: string }
  | { kind: "track"; trackId: string }
  | { kind: "session"; sessionId: string };

/**
 * The scope as one address token: `pod`, `workspace:<id>`, `project:<id>`,
 * `track:<id>`, `session:<id>`.
 */
export function encodeActivityScope(scope: ActivityScope): string {
  switch (scope.kind) {
    case "pod":
      return "pod";
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "track":
      return `track:${scope.trackId}`;
    case "session":
      return `session:${scope.sessionId}`;
  }
}

/** Read an address token back. Anything else ⇒ `undefined` (no override). */
export function parseActivityScope(token: unknown): ActivityScope | undefined {
  if (token === "pod") return { kind: "pod" };
  if (typeof token !== "string") return undefined;
  const sep = token.indexOf(":");
  const kind = token.slice(0, sep);
  const id = token.slice(sep + 1);
  if (sep < 1 || !id) return undefined;
  if (kind === "project") return { kind, projectId: id };
  if (kind === "workspace") return { kind, workspaceId: id };
  if (kind === "track") return { kind, trackId: id };
  if (kind === "session") return { kind, sessionId: id };
  return undefined;
}

/**
 * The scope as the door input `activity.daily` and `activity.list` take.
 * `pod` is the absent lens — the WHOLE floor, never the active-space header.
 */
export function activityScopeFilter(scope: ActivityScope): {
  projectId?: string;
  workspaceId?: string;
  trackId?: string;
  sessionId?: string;
} {
  switch (scope.kind) {
    case "pod":
      return {};
    case "workspace":
      return { workspaceId: scope.workspaceId };
    case "project":
      return { projectId: scope.projectId };
    case "track":
      return { trackId: scope.trackId };
    case "session":
      return { sessionId: scope.sessionId };
  }
}

// ── The ramp (one recipe, every surface) ────────────────────────────────────

/**
 * The colour recipe of the five levels, as mix weights in OKLab over an OPAQUE
 * ground (the page background — a translucent surface would make a cell's
 * colour depend on what sits under it):
 *
 *   0  = `ink` at `empty` over the ground (a visible empty day, not a hole)
 *   1–3 = `primary` at `steps[i]` over level 0
 *   4  = `ink` at `peak` over `primary` (darker than the brand fill in light,
 *        brighter in dark — the ramp needs that room to keep its steps apart)
 *
 * The web writes it as `color-mix(in oklab, …)` in `activity-heatmap.css`
 * (a test pins the CSS to these numbers); relay resolves it with
 * `resolveActivityRamp`. Validated with the dataviz ordinal checks
 * (`ACTIVITY_RAMP_FLOOR`) in light AND dark.
 */
export const ACTIVITY_RAMP = {
  empty: 0.1,
  steps: [0.52, 0.76, 1] as const,
  peak: 0.28,
} as const;

/**
 * The dataviz skill's ordinal-ramp floors: adjacent levels ≥ 0.06 apart in
 * OKLCH lightness, and the faintest data level (1) ≥ 2:1 against the ground.
 */
export const ACTIVITY_RAMP_FLOOR = {
  stepL: 0.06,
  faintestContrast: 2,
} as const;

type Rgb = [number, number, number];

function hexRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toByte = (c: number) => {
  const v = Math.max(0, Math.min(1, c));
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
};

function toOklab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb.map(toLinear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toByte) as Rgb;
}

const rgbHex = (rgb: Rgb) =>
  `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** CSS `color-mix(in oklab, fg p, bg)` for opaque colours, as hex. */
function mixOklab(fg: string, p: number, bg: string): string {
  const a = toOklab(hexRgb(fg));
  const b = toOklab(hexRgb(bg));
  return rgbHex(fromOklab(a.map((v, i) => v * p + b[i]! * (1 - p)) as Rgb));
}

/** OKLCH/OKLab lightness of a hex colour (0–1). */
function oklabLightness(hex: string): number {
  return toOklab(hexRgb(hex))[0];
}

/** WCAG 2 contrast ratio of two hex colours. */
function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = hexRgb(hex).map(toLinear) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `ACTIVITY_RAMP` resolved to five opaque hex colours (index = level), from
 * the theme's opaque `ground` (page background), `ink` (text) and `primary`.
 */
export function resolveActivityRamp(colors: {
  ground: string;
  ink: string;
  primary: string;
}): [string, string, string, string, string] {
  const empty = mixOklab(colors.ink, ACTIVITY_RAMP.empty, colors.ground);
  const [s1, s2, s3] = ACTIVITY_RAMP.steps;
  return [
    empty,
    mixOklab(colors.primary, s1, empty),
    mixOklab(colors.primary, s2, empty),
    mixOklab(colors.primary, s3, empty),
    mixOklab(colors.ink, ACTIVITY_RAMP.peak, colors.primary),
  ];
}

/**
 * The dataviz ordinal checks on a resolved ramp (`ground` = what the cells sit
 * on): the lightness gap between each pair of adjacent levels, ordered from
 * level 0 up, and the contrast of the empty and faintest data levels. `ok` =
 * every gap ≥ `ACTIVITY_RAMP_FLOOR.stepL` in the SAME direction (monotone)
 * and level 1 ≥ `ACTIVITY_RAMP_FLOOR.faintestContrast`.
 */
export function checkActivityRamp(
  ramp: readonly string[],
  ground: string
): {
  stepL: number[];
  emptyContrast: number;
  faintestContrast: number;
  ok: boolean;
} {
  const L = ramp.map(oklabLightness);
  const gaps = L.slice(1).map((l, i) => l - L[i]!);
  const dir = Math.sign(gaps[gaps.length - 1] ?? 0);
  const stepL = gaps.map((g) => g * dir);
  const faintestContrast = contrastRatio(ramp[1]!, ground);
  return {
    stepL,
    emptyContrast: contrastRatio(ramp[0]!, ground),
    faintestContrast,
    ok:
      stepL.every((g) => g >= ACTIVITY_RAMP_FLOOR.stepL) &&
      faintestContrast >= ACTIVITY_RAMP_FLOOR.faintestContrast,
  };
}

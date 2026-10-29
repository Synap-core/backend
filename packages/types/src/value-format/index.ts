/**
 * `@synap-core/types/value-format`: the one door for how a value reads, in
 * every runtime (pod, CLI, Electron, web, React Native on Hermes) and in each
 * locale Synap ships.
 *
 * - dates, times, relative time and elapsed clocks (`dates.ts`);
 * - numbers, counts with a floor, compact counts, sizes, progress and
 *   durations (`numbers.ts`).
 *
 * Every formatter takes `{ locale?: Locale }` (`@synap-core/types/i18n`) and
 * writes English without it. French is written as tables, CLDR's forms, with
 * no `Intl`, so it reads the same on every engine. Moved here from
 * `@synap-core/headless/value-format` (plan 915cc937, stage P3), which keeps a
 * re-export.
 */
export { formatLocale, type ValueFormatOptions } from "./locale.js";
export {
  formatBytes,
  formatCompactCount,
  formatDuration,
  formatFloorCount,
  formatNumber,
  formatProgress,
  type NumberFormatOptions,
} from "./numbers.js";
export {
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
  type DateInput,
} from "./dates.js";

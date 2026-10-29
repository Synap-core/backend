/**
 * How a number, a count, a size, a progress and a duration read, in each
 * locale Synap ships.
 *
 * Written as code, not asked of `Intl.NumberFormat`: Hermes' `Intl` is partial
 * (survey ca310b65 §5), and the same number must read the same on the desk and
 * the phone. The rules are CLDR's for the two locales:
 *
 *   en  1,234.5    decimal point, comma between thousands
 *   fr  1 234,5    decimal comma, narrow no-break space (U+202F) between thousands
 *
 * In French a unit symbol is held to its number by a no-break space (U+00A0),
 * so "412 Ko" or "5 min" never breaks across a line. English keeps its compact
 * forms ("1.2k", "4.2s", "12m 5s"), unchanged from the formatters these replace.
 */
import type { Locale } from "../i18n/locale.js";
import { formatLocale, type ValueFormatOptions } from "./locale.js";

/** French: the no-break space between a number and its unit symbol. */
const NBSP = "\u00a0";

const SEPARATORS: Readonly<Record<Locale, { decimal: string; group: string }>> =
  {
    en: { decimal: ".", group: "," },
    fr: { decimal: ",", group: "\u202f" },
  };

/** {@link formatNumber}'s options. */
export interface NumberFormatOptions extends ValueFormatOptions {
  /** Fraction digits always shown, padded with zeros. Default 0. */
  minimumFractionDigits?: number;
  /** Fraction digits at most, rounded; trailing zeros dropped. Default 3, as `Intl`. */
  maximumFractionDigits?: number;
}

/**
 * A number as a person reads it: "1,234.5" in English, "1 234,5" in French.
 * Rounded to `maximumFractionDigits` (3 by default), trailing zeros dropped
 * down to `minimumFractionDigits`. A value that is not finite, or too large
 * for a fixed form (1e21 and up), prints as `String(value)`.
 */
export function formatNumber(
  value: number,
  options: NumberFormatOptions = {}
): string {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return String(value);
  const { decimal, group } = SEPARATORS[formatLocale(options)];
  const min = Math.max(0, options.minimumFractionDigits ?? 0);
  const max = Math.max(min, options.maximumFractionDigits ?? 3);
  const fixed = Math.abs(value).toFixed(max);
  const [whole, fraction = ""] = fixed.split(".");
  let digits = fraction.replace(/0+$/, "");
  if (digits.length < min) digits = digits.padEnd(min, "0");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  // A value that rounds to zero carries no sign: "0", never "-0".
  const sign = value < 0 && /[1-9]/.test(fixed) ? "-" : "";
  return `${sign}${grouped}${digits ? `${decimal}${digits}` : ""}`;
}

/**
 * THE count formatter for a count that may be a floor: "3", "100+". A capped
 * read (the scan stopped at its limit) says so with a trailing "+", never a
 * bare N that reads as exact (ui-composition §11 "one number, one source").
 * Every "N+" Synap prints goes through here; hosts reuse it rather than
 * writing `${n}+` again. Moved from `lens/header.ts` (plan 915cc937 Q6).
 */
export function formatFloorCount(
  count: number,
  floor = false,
  options?: ValueFormatOptions
): string {
  const n = formatNumber(count, options);
  return floor ? `${n}+` : n;
}

const COMPACT_UNITS: Readonly<Record<Locale, { k: string; m: string }>> = {
  en: { k: "k", m: "M" },
  fr: { k: `${NBSP}k`, m: `${NBSP}M` },
};

/**
 * A large count, compact: "950", "1.2k", "12k", "1.5M", "40M" ("1,2 k",
 * "1,5 M" in French). One decimal below 10 of a unit, where it still says
 * something ("1.2k", never "1.0k"); none above.
 */
export function formatCompactCount(
  n: number,
  options?: ValueFormatOptions
): string {
  const locale = formatLocale(options);
  const unit = COMPACT_UNITS[locale];
  if (!Number.isFinite(n) || n < 1000) return formatNumber(n, { locale });
  const k = n / 1000;
  if (k < 10)
    return `${formatNumber(k, { locale, maximumFractionDigits: 1 })}${unit.k}`;
  // 999,600 rounds to 1000k: read it as millions instead.
  if (Math.round(k) < 1000)
    return `${formatNumber(Math.round(k), { locale })}${unit.k}`;
  const m = n / 1_000_000;
  const digits = m >= 10 ? 0 : 1;
  return `${formatNumber(m, { locale, maximumFractionDigits: digits })}${unit.m}`;
}

const BYTE_UNITS: Readonly<
  Record<Locale, { space: string; units: readonly string[] }>
> = {
  en: { space: " ", units: ["B", "KB", "MB", "GB", "TB"] },
  // Octets: what a French file manager writes.
  fr: { space: NBSP, units: ["o", "Ko", "Mo", "Go", "To"] },
};

/**
 * A byte count as a human size: "412 KB", "2.1 MB" ("412 Ko", "2,1 Mo").
 *
 * Decimal units (1000), which is what a file manager and an upload dialog both
 * report, so a reviewer comparing this to the file on their device sees the
 * same number. One decimal below 10 ("2.1 MB"), none above ("412 KB"): the
 * precision a size is actually read at. '' for a negative or non-finite value.
 */
export function formatBytes(
  bytes: number,
  options?: ValueFormatOptions
): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const locale = formatLocale(options);
  const { space, units } = BYTE_UNITS[locale];
  if (bytes < 1000)
    return `${formatNumber(Math.round(bytes), { locale })}${space}${units[0]}`;
  let value = bytes / 1000;
  let unit = 1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown =
    value < 10
      ? formatNumber(value, {
          locale,
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })
      : formatNumber(Math.round(value), { locale });
  return `${shown}${space}${units[unit]}`;
}

const PROGRESS_JOIN: Readonly<Record<Locale, string>> = {
  en: "of",
  fr: "sur",
};

/** How far along: "3 of 5" ("3 sur 5"). */
export function formatProgress(
  current: number,
  total: number,
  options?: ValueFormatOptions
): string {
  const locale = formatLocale(options);
  return `${formatNumber(current, { locale })} ${PROGRESS_JOIN[locale]} ${formatNumber(total, { locale })}`;
}

/** The unit symbols of a span of time, each with its leading space if any. */
export interface DurationUnits {
  ms: string;
  s: string;
  min: string;
  h: string;
  d: string;
}

/** Shared with the elapsed clock in `dates.ts`, so a span reads one way. */
export const DURATION_UNITS: Readonly<Record<Locale, DurationUnits>> = {
  en: { ms: "ms", s: "s", min: "m", h: "h", d: "d" },
  fr: {
    ms: `${NBSP}ms`,
    s: `${NBSP}s`,
    min: `${NBSP}min`,
    h: `${NBSP}h`,
    d: `${NBSP}j`,
  },
};

/**
 * How long something took, from milliseconds: the two largest units that say
 * something.
 *
 *   < 1s     850ms           850 ms
 *   < 60s    4.2s            4,2 s
 *   < 60m    12m 5s          12 min 5 s
 *   < 24h    3h 5m           3 h 5 min
 *   longer   2d 4h           2 j 4 h
 *
 * Seconds are kept below a minute (a step that ran for 4.2s is a different
 * fact from one that ran "0m"); above an hour they are noise and dropped.
 * '' for a negative or non-finite span. For a span still running (a state
 * pill's clock), use `formatElapsed`.
 */
export function formatDuration(
  ms: number,
  options?: ValueFormatOptions
): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const locale = formatLocale(options);
  const u = DURATION_UNITS[locale];
  const n = (value: number) => formatNumber(value, { locale });
  if (Math.round(ms) < 1000) return `${n(Math.round(ms))}${u.ms}`;
  if (ms < 60_000) {
    const seconds = formatNumber(ms / 1000, {
      locale,
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    return `${seconds}${u.s}`;
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60)
    return `${n(minutes)}${u.min} ${n(Math.floor((ms % 60_000) / 1000))}${u.s}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${n(hours)}${u.h} ${n(minutes % 60)}${u.min}`;
  return `${n(Math.floor(hours / 24))}${u.d} ${n(hours % 24)}${u.h}`;
}

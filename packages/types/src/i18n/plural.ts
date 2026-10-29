/**
 * CLDR cardinal plural rules for the supported locales, written as code.
 *
 * No `Intl.PluralRules`: Hermes support for it is unconfirmed on our relay
 * build, and two rules do not need a runtime. Source: CLDR 46
 * `supplemental/plurals.xml`, operands as defined in UTS #35 (`i` = integer
 * digits of |n|, `v` = number of visible fraction digits). Only cardinal rules:
 * ordinals ("1st", "1er") are not part of the message subset.
 *
 * A JS number carries no trailing zeros, so `v` is read from its shortest
 * representation: `1.0` IS `1` here (CLDR would call "1.0" `other` in English).
 * Format such a value as a string before it reaches a message if that matters.
 */
import type { Locale } from "./locale.js";

/** The six CLDR plural categories; a locale uses a subset of them. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/** The categories each locale's rules can return, `other` always last. */
export const PLURAL_CATEGORIES: Readonly<
  Record<Locale, readonly PluralCategory[]>
> = {
  en: ["one", "other"],
  fr: ["one", "many", "other"],
};

/** CLDR operands `i` and `v` of a finite number. */
function operands(n: number): { i: number; v: number } {
  const abs = Math.abs(n);
  const i = Math.trunc(abs);
  const text = String(abs);
  const exp = text.indexOf("e-");
  if (exp !== -1) {
    // 1.5e-7: the mantissa's fraction digits plus the exponent.
    const mantissa = text.slice(0, exp);
    const dot = mantissa.indexOf(".");
    const fraction = dot === -1 ? 0 : mantissa.length - dot - 1;
    return { i, v: fraction + Number(text.slice(exp + 2)) };
  }
  const dot = text.indexOf(".");
  return { i, v: dot === -1 ? 0 : text.length - dot - 1 };
}

/**
 * The plural category of `n` in `locale`. A value that is not a finite number
 * is `other`, which every message must provide.
 *
 * - en: `one` when i = 1 and v = 0; else `other`.
 * - fr: `one` when i = 0 or 1 (so 0, 1 and 1.5 are singular); `many` for an
 *   integer multiple of a million (1 000 000, 2 000 000); else `other`.
 */
export function pluralCategory(locale: Locale, n: number): PluralCategory {
  if (typeof n !== "number" || !Number.isFinite(n)) return "other";
  const { i, v } = operands(n);
  if (locale === "fr") {
    if (i === 0 || i === 1) return "one";
    if (v === 0 && i % 1_000_000 === 0) return "many";
    return "other";
  }
  return i === 1 && v === 0 ? "one" : "other";
}

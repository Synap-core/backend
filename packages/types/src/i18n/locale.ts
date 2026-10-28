/**
 * The languages Synap's chrome is written in, and how a person's preferred
 * language tags resolve to one of them.
 *
 * English is the source language: every catalog is written in English first
 * and every other locale falls back to it.
 */

/** Every locale Synap ships a catalog for. English first: it is the source. */
export const SUPPORTED_LOCALES = ["en", "fr"] as const;

/** A language Synap's chrome can be shown in. */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** The source language, and the answer when nothing else matches. */
export const DEFAULT_LOCALE: Locale = "en";

/** True when `value` is one of {@link SUPPORTED_LOCALES}, exactly. */
export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * The first supported locale among `preferred` language tags, in order;
 * {@link DEFAULT_LOCALE} when none is supported.
 *
 * Tags are matched on their primary language subtag, case-insensitively, with
 * `-` or `_` as separator: `fr-CA`, `FR`, `fr_FR` all resolve to `fr`. Pass the
 * stored preference first and the device's languages after it, e.g.
 * `resolveLocale([user.locale, ...deviceLanguages])`. No `Intl` involved, so it
 * runs the same on Hermes.
 */
export function resolveLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    if (typeof tag !== "string") continue;
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

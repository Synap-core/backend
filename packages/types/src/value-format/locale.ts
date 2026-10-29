/**
 * Which language a value formatter writes in.
 *
 * Every formatter takes `{ locale?: Locale }` in its options. A caller that
 * knows the reader's language passes it; one that does not gets the default.
 * This file is the ONE place that default is read, so when the ambient client
 * locale lands (`ambientCatalogLocale()` in `@synap-core/types/i18n`, plan
 * 915cc937 D1) only {@link formatLocale} changes. Until then the default is
 * English, and the pod, the CLI and agents stay English by construction.
 */
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/locale.js";

/** The options every value formatter accepts. */
export interface ValueFormatOptions {
  /** The language to write in; the default locale when absent. */
  locale?: Locale;
}

/**
 * The language a formatter writes in: the caller's, else the default. A tag
 * that is not a supported locale (a JS caller passing "fr-FR") reads as the
 * default rather than crashing a table lookup: resolve tags with
 * `resolveLocale` before they get here.
 */
export function formatLocale(options?: ValueFormatOptions): Locale {
  const locale = options?.locale;
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

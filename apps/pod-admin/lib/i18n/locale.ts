/**
 * Which language the Pod Console speaks, the pure half of `locale-provider.tsx`.
 *
 * The person's language is `users.me.locale` (`users.setLocale` writes it).
 * Until that read answers, or when it fails (a page outside sign-in), the
 * console speaks English, the source language: guessing from the browser
 * would flash French at a person who chose English.
 */

import {
  DEFAULT_LOCALE,
  resolveLocale,
  type Locale,
} from "@synap-core/types/i18n";

/** The catalog language for a `users.me` answer (absent while loading or failed). */
export function consoleLocaleOf(
  me: { locale?: string | null } | null | undefined
): Locale {
  return me?.locale ? resolveLocale([me.locale]) : DEFAULT_LOCALE;
}

/**
 * The ambient catalog locale: the language code outside React reads when it
 * is not given one (founder decision D1, plan 915cc937, 2026-10-29).
 *
 * The vocabulary's resolvers and the models that call them take `locale?`;
 * with none they read {@link ambientCatalogLocale}. It is `"en"` until a
 * CLIENT host root sets it once from the person's language (the web or relay
 * `LocaleProvider`, over the same tag `useLocale()` gives), and changing the
 * language remounts the tree, so no memoised word outlives it.
 *
 * The server never sets it: pod, MCP, CLI and agent text stay English by
 * construction, and a server that writes for a person passes that person's
 * locale explicitly (`createT(recipient.locale, …)`). A tripwire holds
 * `setAmbientCatalogLocale` out of every server package
 * (`__tripwires__/ambient-locale-client-only.test.ts`). Tests that set it
 * reset it to `"en"` after each test.
 */
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locale.js";

let ambient: Locale = DEFAULT_LOCALE;

/** The catalog locale code without a `locale` argument uses: `"en"` until a client host sets it. */
export function ambientCatalogLocale(): Locale {
  return ambient;
}

/**
 * Set the ambient catalog locale. CLIENT host roots only, once per mount; a
 * value outside {@link SUPPORTED_LOCALES} (an untyped caller) reads English.
 */
export function setAmbientCatalogLocale(locale: Locale): void {
  ambient = isLocale(locale) ? locale : DEFAULT_LOCALE;
}

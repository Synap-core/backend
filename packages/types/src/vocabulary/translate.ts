/**
 * How the vocabulary's resolvers read a locale's catalog: the one place a
 * resolver turns `locale?` into words. Internal to the folder (not exported
 * from `index.ts`).
 *
 * English answers come from the curated tables themselves, so a resolver's
 * English output is unchanged by construction; another locale's word wins
 * when its catalog has one, and English answers when it does not (the same
 * fallback as `createT`).
 */
import { ambientCatalogLocale } from "../i18n/ambient.js";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/locale.js";
import type { Noun } from "../i18n/noun.js";
import { createT, type TFunction } from "../i18n/translator.js";
import {
  vocabularySentencesEn,
  type NounSlug,
  type VocabularySentencesEn,
} from "./catalog.en.js";
import { vocabularyFr, vocabularyFrNouns } from "./catalog.fr.js";

/**
 * The locale a resolver answers in: the one it was given, else the ambient
 * one. A value that is not a locale reads as none: a resolver passed straight
 * to `.map` receives the index there.
 */
export function catalogLocaleOf(locale: Locale | undefined): Locale {
  return isLocale(locale) ? locale : ambientCatalogLocale();
}

const TRANSLATIONS: Readonly<
  Partial<Record<Locale, Readonly<Record<string, string>>>>
> = { fr: vocabularyFr };

/**
 * The word at `key` in `locale`'s catalog, or undefined when English answers
 * (the locale is English, or its catalog lacks the key).
 */
export function translatedWord(
  key: string,
  locale: Locale
): string | undefined {
  if (locale === DEFAULT_LOCALE) return undefined;
  const catalog = TRANSLATIONS[locale];
  return catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
}

const translators = new Map<Locale, TFunction<VocabularySentencesEn>>();

/** The door's sentences in `locale` (memoised per locale). */
export function sentences(locale: Locale): TFunction<VocabularySentencesEn> {
  let t = translators.get(locale);
  if (!t) {
    t = createT(locale, { en: vocabularySentencesEn, fr: vocabularyFr });
    translators.set(locale, t);
  }
  return t;
}

/** A catalog slug's noun in a non-English locale, or undefined when its catalog has none. */
export function translatedNoun(slug: string, locale: Locale): Noun | undefined {
  if (locale !== "fr" || !Object.hasOwn(vocabularyFrNouns, slug)) {
    return undefined;
  }
  const one = translatedWord(`kind.${slug}.one`, locale);
  const other = translatedWord(`kind.${slug}.other`, locale);
  if (one === undefined || other === undefined) return undefined;
  const grammar = vocabularyFrNouns[slug as NounSlug];
  return { one, other, gender: grammar.gender, elides: grammar.elides };
}

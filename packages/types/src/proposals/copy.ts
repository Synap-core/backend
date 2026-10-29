/**
 * The words of this folder's sentences, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type, French translates it. DRAFT French,
 * awaiting the founder's review with the vocabulary's (session 1129210f).
 */
import { ambientCatalogLocale } from "../i18n/ambient.js";
import { createT, type Catalog, type Locale } from "../i18n/index.js";

export const en = {
  // A held-writes pack's name counts the writes it holds ("Claude Code,
  // 2026-10-27, 12 items").
  "proposals.heldWrites.items": "{n, plural, one {# item} other {# items}}",
} as const;

export const fr: Catalog<typeof en> = {
  "proposals.heldWrites.items":
    "{n, plural, one {# élément} many {# d’éléments} other {# éléments}}",
};

export const proposalsCopy = { en, fr } as const;

/** This folder's translator, in `locale` (else the ambient catalog locale). */
export function proposalsT(locale?: Locale) {
  return createT(locale ?? ambientCatalogLocale(), proposalsCopy);
}

/**
 * The proposal page's counted sentences, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French, awaiting the founder's
 * review with the vocabulary's (session 1129210f).
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "deferredWrites.count": "{n, plural, one {# write} other {# writes}}",
  "deferredWrites.showAll":
    "Show all {n, plural, one {# write} other {# writes}}",
  "deferredWrites.unreadable":
    "{n, plural, one {# write} other {# writes}} could not be read — the raw request is under Advanced.",
} as const;

export const fr: Catalog<typeof en> = {
  "deferredWrites.count":
    "{n, plural, one {# écriture} many {# d’écritures} other {# écritures}}",
  "deferredWrites.showAll":
    "{n, plural, one {Afficher l’écriture} other {Afficher les # écritures}}",
  "deferredWrites.unreadable":
    "{n, plural, one {# écriture n’a pas pu être lue} other {# écritures n’ont pas pu être lues}}\u00a0: la requête brute est dans Avancé.",
};

/** The page's translator, in the ambient catalog locale. */
export function proposalPageT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

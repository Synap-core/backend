/**
 * The kinds page's words, as catalogs (`@synap-core/types/i18n`): English is
 * the source and the type. DRAFT French ("vous"), awaiting the founder's
 * review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "exit.edit": "Edit kinds in app",
  "tidy.title": "Needs tidying",
  "tidy.failed": "Couldn't check what needs tidying.",
  "tidy.hint":
    "{n, plural, one {# thing worth a look} other {# things worth a look}}",
  "action.openApp": "Open in app",
  "action.openReview": "Open in Review",
  "action.retire": "Retire",
} as const;

export const fr: Catalog<typeof en> = {
  "exit.edit": "Modifier les types dans l’app",
  "tidy.title": "À ranger",
  "tidy.failed": "Impossible de vérifier ce qui est à ranger.",
  "tidy.hint":
    "{n, plural, one {# élément à regarder} other {# éléments à regarder}}",
  "action.openApp": "Ouvrir dans l’app",
  "action.openReview": "Ouvrir dans Demandes",
  "action.retire": "Retirer",
};

/** The kinds page's translator, in the ambient catalog locale. */
export function kindsT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

/**
 * Words shared by the console's app-level pieces (the write-mode choice), as
 * catalogs (`@synap-core/types/i18n`): English is the source and the type.
 * DRAFT French, awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "writeMode.recommended": "(recommended)",
  "writeMode.showAll": "Show all {n}",
  "brand.home": "Synap, go to Home",
} as const;

export const fr: Catalog<typeof en> = {
  "writeMode.recommended": "(recommandé)",
  "writeMode.showAll": "Voir les {n}",
  "brand.home": "Synap, aller à l’accueil",
};

/** The app-level translator, in the ambient catalog locale. */
export function appT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

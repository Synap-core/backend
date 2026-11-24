/**
 * Words of the content renderers' marks (a reference in prose), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French, awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "ref.failed": "Couldn’t look this up",
  "ref.retry": "Couldn’t look this up. Try again",
} as const;

export const fr: Catalog<typeof en> = {
  "ref.failed": "Impossible de retrouver ceci",
  "ref.retry": "Impossible de retrouver ceci. Réessayer",
};

/** The content marks' translator, in the ambient catalog locale. */
export function contentMarksT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

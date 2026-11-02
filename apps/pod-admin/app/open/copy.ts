/**
 * The words of `/open`'s cards, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French, awaiting the founder's
 * review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "bounce.noWebPage": "No web page",
  "bounce.inApp": "It has no page on the web yet. Open it in the Synap app.",
} as const;

export const fr: Catalog<typeof en> = {
  "bounce.noWebPage": "Pas de page web",
  "bounce.inApp":
    "Cet élément n’a pas encore de page sur le web. Ouvrez-le dans l’application Synap.",
};

/** `/open`'s translator, in the ambient catalog locale. */
export function openT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

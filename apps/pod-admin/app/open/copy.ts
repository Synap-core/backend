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
  "bounce.operator":
    "It has no page on the web yet. It lives in the Synap desktop app.",
  "bounce.member":
    "It has no page on the web yet. An admin of your company’s Synap can open it for you.",
} as const;

export const fr: Catalog<typeof en> = {
  "bounce.noWebPage": "Pas de page web",
  "bounce.operator":
    "Il n’a pas encore de page sur le web. Il se trouve dans l’application Synap pour ordinateur.",
  "bounce.member":
    "Il n’a pas encore de page sur le web. Un administrateur du Synap de votre entreprise peut l’ouvrir pour vous.",
};

/** `/open`'s translator, in the ambient catalog locale. */
export function openT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

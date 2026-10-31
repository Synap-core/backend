/**
 * Words of the object views, as catalogs (`@synap-core/types/i18n`): English
 * is the source and the type. DRAFT French, awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "agent.trust.change": "Change what it may do without asking",
  "agent.trust.askAdmin":
    "An admin of your company’s Synap can change what it may do without asking.",
} as const;

export const fr: Catalog<typeof en> = {
  "agent.trust.change": "Changer ce qu’il peut faire sans demander",
  "agent.trust.askAdmin":
    "Un administrateur du Synap de votre entreprise peut changer ce qu’il peut faire sans demander.",
};

/** The object views' translator, in the ambient catalog locale. */
export function objectViewsT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

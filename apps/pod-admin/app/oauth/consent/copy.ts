/**
 * The short consent's words (a pod app asking for one more thing), as
 * catalogs (`@synap-core/types/i18n`): English is the source and the type.
 * DRAFT French ("vous"), awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "ask.alsoAllow": "Also allow",
  "ask.unavailable":
    "It also asked for something none of your spaces can hold; that part is left out.",
  "ask.keeps": "What it already has stays as it is.",
  "ask.allow": "Allow",
  "ask.notNow": "Not now",
  "ask.seeAll": "See everything it has",
} as const;

export const fr: Catalog<typeof en> = {
  "ask.alsoAllow": "Autoriser aussi",
  "ask.unavailable":
    "Elle a aussi demandé quelque chose qu’aucun de vos espaces ne peut contenir ; cette partie est laissée de côté.",
  "ask.keeps": "Ce qu’elle a déjà reste tel quel.",
  "ask.allow": "Autoriser",
  "ask.notNow": "Pas maintenant",
  "ask.seeAll": "Voir tout ce qu’elle a",
};

/** The consent's translator, in the ambient catalog locale. */
export function consentT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

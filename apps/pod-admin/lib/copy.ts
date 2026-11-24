/**
 * Words the console's plain-TypeScript doors say to a person (sign-in
 * recovery), as catalogs (`@synap-core/types/i18n`): English is the source
 * and the type. DRAFT French ("vous"), awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "rateLimited.wait":
    "The pod asked for a short pause. You can continue in {n, plural, one {# second} other {# seconds}}.",
} as const;

export const fr: Catalog<typeof en> = {
  "rateLimited.wait":
    "Le pod a demandé une courte pause. Vous pourrez continuer dans {n, plural, one {# seconde} other {# secondes}}.",
};

/** The console doors' translator, in the ambient catalog locale. */
export function libT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

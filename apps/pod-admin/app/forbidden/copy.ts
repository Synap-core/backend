/**
 * The words of `/forbidden`, as catalogs (`@synap-core/types/i18n`): English
 * is the source and the type. DRAFT French, awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  title: "This page is for admins",
  body: "You’re signed in, but only an admin of your company’s Synap can open this page. Ask them if you need something here.",
  home: "Back to home",
  signOut: "Sign out",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Cette page est réservée aux administrateurs",
  body: "Votre session est ouverte, mais seul un administrateur du Synap de votre entreprise peut ouvrir cette page. Demandez-lui si vous en avez besoin.",
  home: "Retour à l’accueil",
  signOut: "Se déconnecter",
};

/** `/forbidden`'s translator, in the ambient catalog locale. */
export function forbiddenT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

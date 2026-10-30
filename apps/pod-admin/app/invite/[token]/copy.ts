/**
 * The words of the invite's Done screen, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French, awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "done.open": "Open in Synap",
  "done.home": "Manage your account on the web",
  "done.signIn": "Sign in on the web",
  "done.apps": "Your company’s apps",
  "done.appsFailed": "Couldn’t load your company’s apps.",
  "done.appsRetry": "Try again",
  "done.phoneGet": "Get the Synap mobile app",
  "done.phoneHint": "On your phone too: decide requests wherever you are.",
} as const;

export const fr: Catalog<typeof en> = {
  "done.open": "Ouvrir dans Synap",
  "done.home": "Gérer votre compte sur le web",
  "done.signIn": "Se connecter sur le web",
  "done.apps": "Les applications de votre entreprise",
  "done.appsFailed":
    "Impossible de charger les applications de votre entreprise.",
  "done.appsRetry": "Réessayer",
  "done.phoneGet": "Installer l’application mobile Synap",
  "done.phoneHint":
    "Aussi sur votre téléphone : décidez des demandes où que vous soyez.",
};

/** The invite page's translator, in the ambient catalog locale. */
export function inviteT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

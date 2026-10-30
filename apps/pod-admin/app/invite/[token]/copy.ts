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
  "done.home": "Go to your home page",
  "done.signIn": "Sign in",
  "done.apps": "Your company’s apps",
  "done.appsFailed": "Couldn’t load your company’s apps.",
  "done.appsRetry": "Try again",
  "done.phoneOpen": "Open in the Synap mobile app",
  "done.phoneGet": "Get the Synap mobile app",
  "done.phoneHint": "On your phone too: decide requests wherever you are.",
} as const;

export const fr: Catalog<typeof en> = {
  "done.home": "Aller à votre page d’accueil",
  "done.signIn": "Se connecter",
  "done.apps": "Les applications de votre entreprise",
  "done.appsFailed":
    "Impossible de charger les applications de votre entreprise.",
  "done.appsRetry": "Réessayer",
  "done.phoneOpen": "Ouvrir dans l’application mobile Synap",
  "done.phoneGet": "Installer l’application mobile Synap",
  "done.phoneHint":
    "Aussi sur votre téléphone : décidez des demandes où que vous soyez.",
};

/** The invite page's translator, in the ambient catalog locale. */
export function inviteT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

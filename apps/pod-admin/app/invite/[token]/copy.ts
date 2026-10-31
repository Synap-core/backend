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
  "done.signInAs":
    "{app, select, yes {In the Synap app, sign in} other {Sign in}} to {where} as {email}{way, select, passkey { with your passkey.} password { with your company’s Synap password.} synap_cloud { with Synap Cloud.} other {.}}",
  "done.yourSynap": "your company’s Synap",
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
  "done.signInAs":
    "{app, select, yes {Dans l’application Synap, connectez-vous} other {Connectez-vous}} sur {where} avec l’adresse {email}{way, select, passkey { et votre clé d’accès.} password { et le mot de passe du Synap de votre entreprise.} synap_cloud { via Synap Cloud.} other {.}}",
  "done.yourSynap": "le Synap de votre entreprise",
};

/** The invite page's translator, in the ambient catalog locale. */
export function inviteT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

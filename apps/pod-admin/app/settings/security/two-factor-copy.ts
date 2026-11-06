/**
 * The 2FA app card's words (the recovery ladder, founder, 6 Nov 2026), as
 * catalogs (`@synap-core/types/i18n`): English is the source and the type.
 * DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "totp.title": "2FA app",
  "totp.hint":
    "A code from an authenticator app confirms it’s you when an approval needs you in person",
  "totp.none": "Not set up",
  "totp.inUse": "In use",
  "totp.added": "{label}, added {when}",
  "totp.loadFailed": "Couldn’t load your 2FA app.",
  "totp.retry": "Try again",
  "totp.add": "Add a 2FA app",
  "totp.defaultLabel": "Authenticator app",
  "totp.scan":
    "Scan this code with your authenticator app (1Password, Dashlane, Google Authenticator…), or type the key below.",
  "totp.key": "Key",
  "totp.copyKey": "Copy the key",
  "totp.code": "Code from the app",
  "totp.confirm": "Confirm",
  "totp.cancel": "Cancel",
  "totp.addedToast": "2FA app added",
  "totp.remove": "Remove",
  "totp.remove.title": "Remove your 2FA app?",
  "totp.remove.consequence":
    "Its codes stop confirming it’s you right away. Every device of yours is told.",
  "totp.remove.confirm": "Remove",
  "totp.failed": "Not changed.",
  "totp.reauth": "Sign in again",
} as const;

export const fr: Catalog<typeof en> = {
  "totp.title": "App de double authentification",
  "totp.hint":
    "Un code d’une app d’authentification confirme que c’est vous quand une approbation demande votre présence",
  "totp.none": "Non configurée",
  "totp.inUse": "Utilisée",
  "totp.added": "{label}, ajoutée {when}",
  "totp.loadFailed":
    "Impossible de charger votre app de double authentification.",
  "totp.retry": "Réessayer",
  "totp.add": "Ajouter une app de double authentification",
  "totp.defaultLabel": "App d’authentification",
  "totp.scan":
    "Scannez ce code avec votre app d’authentification (1Password, Dashlane, Google Authenticator…), ou saisissez la clé ci-dessous.",
  "totp.key": "Clé",
  "totp.copyKey": "Copier la clé",
  "totp.code": "Code de l’app",
  "totp.confirm": "Confirmer",
  "totp.cancel": "Annuler",
  "totp.addedToast": "App de double authentification ajoutée",
  "totp.remove": "Retirer",
  "totp.remove.title": "Retirer votre app de double authentification ?",
  "totp.remove.consequence":
    "Ses codes cessent aussitôt de confirmer que c’est vous. Chacun de vos appareils en est informé.",
  "totp.remove.confirm": "Retirer",
  "totp.failed": "Rien n’a changé.",
  "totp.reauth": "Se reconnecter",
};

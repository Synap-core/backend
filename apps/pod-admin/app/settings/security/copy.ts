/**
 * Security's words for the passkeys card and its own page (founder decision
 * 2 of 4 Nov: a new passkey is confirmed by an existing factor first), as
 * catalogs (`@synap-core/types/i18n`): English is the source and the type.
 * DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "passkeys.title": "Passkeys",
  "passkeys.hint": "Sign in with this device’s lock, no password",
  "passkeys.count": "{n, plural, =0 {None} one {# passkey} other {# passkeys}}",
  "passkeys.loadFailed": "Couldn’t load your passkey settings.",
  "passkeys.disabled": "Passkeys aren’t turned on for this pod.",
  "passkeys.unsupported":
    "This browser can’t create a passkey. Open this page on a device that can.",
  "passkeys.add": "Add a passkey",
  "passkeys.added": "Passkey added",
  "passkeys.addFailed": "Couldn’t add the passkey. Try again.",
  "passkeys.copyDetails": "Copy details",
  "passkeys.copyDetailsA11y": "Copy the technical details of this error",
  "passkeys.grant.expired":
    "Your confirmation ran out before the new passkey was created.",
  "passkeys.grant.again": "Confirm again",
  "passkeys.page.back": "Security",
  "passkeys.page.lead":
    "A passkey signs you in with this device’s lock, and confirms it’s you for sensitive approvals.",
  "passkeys.grant.why":
    "You already have a passkey, so a new one needs a confirmation from it first: an app or an AI using your session can’t add its own.",
  "passkeys.grant.ready":
    "Confirmed. Create your new passkey within 5 minutes.",
  "passkeys.grant.create": "Create the passkey",
  "passkeys.grant.failed": "Couldn’t confirm it’s you. Try again.",
  "passkeys.relayOnly":
    "Your account is protected by Face ID in Relay, so a new passkey needs a confirmation from Relay first, and Relay can’t give it yet.",
  "passkeys.devicesFailed":
    "Couldn’t check which devices protect your account.",
  "passkeys.retry": "Try again",
};

export const fr: Catalog<typeof en> = {
  "passkeys.title": "Clés d’accès",
  "passkeys.hint":
    "Connectez-vous avec le verrouillage de cet appareil, sans mot de passe",
  "passkeys.count":
    "{n, plural, =0 {Aucune} one {# clé d’accès} other {# clés d’accès}}",
  "passkeys.loadFailed": "Impossible de charger vos réglages de clés d’accès.",
  "passkeys.disabled": "Les clés d’accès ne sont pas activées sur ce pod.",
  "passkeys.unsupported":
    "Ce navigateur ne peut pas créer de clé d’accès. Ouvrez cette page sur un appareil qui le peut.",
  "passkeys.add": "Ajouter une clé d’accès",
  "passkeys.added": "Clé d’accès ajoutée",
  "passkeys.addFailed": "Impossible d’ajouter la clé d’accès. Réessayez.",
  "passkeys.copyDetails": "Copier les détails",
  "passkeys.copyDetailsA11y": "Copier les détails techniques de cette erreur",
  "passkeys.grant.expired":
    "Votre confirmation a expiré avant la création de la nouvelle clé d’accès.",
  "passkeys.grant.again": "Confirmer de nouveau",
  "passkeys.page.back": "Sécurité",
  "passkeys.page.lead":
    "Une clé d’accès vous connecte avec le verrouillage de cet appareil, et confirme que c’est vous pour les approbations sensibles.",
  "passkeys.grant.why":
    "Vous avez déjà une clé d’accès : une nouvelle doit d’abord être confirmée avec elle. Une app ou une IA qui utilise votre session ne peut pas ajouter la sienne.",
  "passkeys.grant.ready":
    "Confirmé. Créez votre nouvelle clé d’accès dans les 5 minutes.",
  "passkeys.grant.create": "Créer la clé d’accès",
  "passkeys.grant.failed": "Impossible de confirmer que c’est vous. Réessayez.",
  "passkeys.relayOnly":
    "Votre compte est protégé par Face ID dans Relay : une nouvelle clé d’accès doit d’abord être confirmée dans Relay, ce que Relay ne permet pas encore.",
  "passkeys.devicesFailed":
    "Impossible de vérifier quels appareils protègent votre compte.",
  "passkeys.retry": "Réessayer",
};

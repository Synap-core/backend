/**
 * Security's words for adding a passkey when the person already holds a
 * proof factor (W3 slice 3, founder decision 2 of 4 Nov), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
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

/**
 * The passkeys card's words (settings Security and pod admin Security, W3
 * slice 3 and W5), as catalogs (`@synap-core/types/i18n`): English is the
 * source and the type. DRAFT French ("vous"), awaiting the founder's review.
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
  "passkeys.title": "Your passkeys",
  "passkeys.hint":
    "Sign in and confirm it’s you with this device’s lock, no password",
  "passkeys.count": "{n, plural, =0 {None} one {# passkey} other {# passkeys}}",
  "passkeys.loadFailed": "Couldn’t load your passkeys.",
  "passkeys.copyDetails": "Copy details",
  "passkeys.copyDetails.aria": "Copy the technical details of this error",
  "passkeys.disabled": "Passkeys aren’t enabled on this pod.",
  "passkeys.unsupported":
    "This browser can’t create a passkey. Open this page on a device that can.",
  "passkeys.add": "Add a passkey",
  "passkeys.added": "Passkey added",
  "passkeys.addFailed": "Couldn’t add the passkey. Try again.",
  "passkeys.empty":
    "No passkey yet. Add one to sign in and approve with this device’s lock.",
  "passkeys.row.name": "Passkey",
  "passkeys.row.added": "Added {date}",
  "passkeys.row.addedUnknown": "Added on an unknown date",
  "passkeys.remove": "Remove",
  "passkeys.remove.aria": "Remove the passkey added {date}",
  "passkeys.remove.title": "Remove this passkey?",
  "passkeys.remove.consequence":
    "You won’t be able to sign in or confirm with it any more. You confirm with a passkey first.",
  "passkeys.remove.confirm": "Remove",
  "passkeys.removed": "Passkey removed",
  "passkeys.removeFailed": "Couldn’t remove the passkey. Try again.",
  "passkeys.block.onlySignIn":
    "It’s how you sign in to this pod: add a password or another passkey before you remove it.",
  "passkeys.block.lastWithProof":
    "It’s your last passkey, and approvals need you in person on this pod: add another passkey first, or turn that off in pod admin, Security.",
  "passkeys.block.unknownMode":
    "It’s your last passkey, and the pod couldn’t say whether approvals need you in person. Try again in a moment.",
  "passkeys.reauth": "This needs a recent sign-in.",
  "passkeys.reauth.action": "Sign in again",
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
  "passkeys.title": "Vos clés d’accès",
  "passkeys.hint":
    "Connectez-vous et confirmez que c’est vous avec le verrouillage de cet appareil, sans mot de passe",
  "passkeys.count":
    "{n, plural, =0 {Aucune} one {# clé d’accès} other {# clés d’accès}}",
  "passkeys.loadFailed": "Impossible de charger vos clés d’accès.",
  "passkeys.copyDetails": "Copier les détails",
  "passkeys.copyDetails.aria": "Copier les détails techniques de cette erreur",
  "passkeys.disabled": "Les clés d’accès ne sont pas activées sur ce pod.",
  "passkeys.unsupported":
    "Ce navigateur ne peut pas créer de clé d’accès. Ouvrez cette page sur un appareil qui le peut.",
  "passkeys.add": "Ajouter une clé d’accès",
  "passkeys.added": "Clé d’accès ajoutée",
  "passkeys.addFailed": "Impossible d’ajouter la clé d’accès. Réessayez.",
  "passkeys.empty":
    "Aucune clé d’accès pour l’instant. Ajoutez-en une pour vous connecter et approuver avec le verrouillage de cet appareil.",
  "passkeys.row.name": "Clé d’accès",
  "passkeys.row.added": "Ajoutée le {date}",
  "passkeys.row.addedUnknown": "Ajoutée à une date inconnue",
  "passkeys.remove": "Retirer",
  "passkeys.remove.aria": "Retirer la clé d’accès ajoutée le {date}",
  "passkeys.remove.title": "Retirer cette clé d’accès ?",
  "passkeys.remove.consequence":
    "Vous ne pourrez plus vous connecter ni confirmer avec elle. Vous confirmez d’abord avec une clé d’accès.",
  "passkeys.remove.confirm": "Retirer",
  "passkeys.removed": "Clé d’accès retirée",
  "passkeys.removeFailed": "Impossible de retirer la clé d’accès. Réessayez.",
  "passkeys.block.onlySignIn":
    "C’est ainsi que vous vous connectez à ce pod : ajoutez un mot de passe ou une autre clé d’accès avant de la retirer.",
  "passkeys.block.lastWithProof":
    "C’est votre dernière clé d’accès, et les approbations demandent votre présence sur ce pod : ajoutez d’abord une autre clé d’accès, ou désactivez cela dans l’administration du pod, Sécurité.",
  "passkeys.block.unknownMode":
    "C’est votre dernière clé d’accès, et le pod n’a pas pu dire si les approbations demandent votre présence. Réessayez dans un instant.",
  "passkeys.reauth": "Cette action demande une connexion récente.",
  "passkeys.reauth.action": "Se reconnecter",
};

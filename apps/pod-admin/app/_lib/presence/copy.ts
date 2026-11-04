/**
 * The words of the proof-of-presence dialog, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. Client
 * words: a request, never a proposal. DRAFT French, awaiting the founder's
 * review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  title: "Confirm it’s you",
  "title.progress": "Confirm it’s you ({index} of {total})",
  action: "To approve “{action}”, confirm with your passkey.",
  "action.unnamed": "To approve this request, confirm with your passkey.",
  why: "Approvals that connect an AI, change who may do what, deploy or delete need you in person, not only a signed-in browser: an app or an AI using your session can’t approve them for you. Your browser will ask for Touch ID, Windows Hello or your security key.",
  confirm: "Confirm with your passkey",
  notNow: "Not now",
  tryAgain: "Try again",
  checking: "Getting a confirmation from your pod…",
  waiting: "Waiting for your passkey…",
  "again.invalid":
    "That passkey didn’t confirm it’s you. Use a passkey of this pod, and let your device ask for Touch ID, Windows Hello or its PIN.",
  "again.expired": "That confirmation took too long. Confirm again.",
  "again.used": "That confirmation was already used. Confirm again.",
  cancelled:
    "Nothing was confirmed: the prompt was closed, or this device has no passkey for this pod.",
  readFailed: "Couldn’t get a confirmation from your pod.",
  ceremonyFailed: "Your passkey couldn’t sign the confirmation.",
  "noPasskey.title": "Add a passkey to approve this here",
  "noPasskey.body":
    "You have no passkey on this pod yet. Add one under Security, then try again.",
  "unsupported.body":
    "This browser can’t use a passkey. Open pod admin in a browser that can, or approve it in Relay.",
  "relay.device": "Or approve it in Relay on {device}, with Face ID.",
  "relay.any": "Or approve it in Relay on your phone, with Face ID.",
  addPasskey: "Add a passkey",
  declined: "Not approved: you didn’t confirm it’s you.",
};

const fr: Catalog<typeof en> = {
  title: "Confirmez que c’est vous",
  "title.progress": "Confirmez que c’est vous ({index} sur {total})",
  action: "Pour approuver « {action} », confirmez avec votre clé d’accès.",
  "action.unnamed":
    "Pour approuver cette demande, confirmez avec votre clé d’accès.",
  why: "Les approbations qui connectent une IA, changent qui peut faire quoi, déploient ou suppriment demandent votre présence, pas seulement un navigateur connecté : une app ou une IA qui utilise votre session ne peut pas les approuver à votre place. Votre navigateur va demander Touch ID, Windows Hello ou votre clé de sécurité.",
  confirm: "Confirmer avec votre clé d’accès",
  notNow: "Pas maintenant",
  tryAgain: "Réessayer",
  checking: "Demande d’une confirmation à votre pod…",
  waiting: "En attente de votre clé d’accès…",
  "again.invalid":
    "Cette clé d’accès n’a pas confirmé que c’est vous. Utilisez une clé d’accès de ce pod, et laissez votre appareil demander Touch ID, Windows Hello ou son code.",
  "again.expired":
    "Cette confirmation a pris trop de temps. Confirmez de nouveau.",
  "again.used": "Cette confirmation a déjà servi. Confirmez de nouveau.",
  cancelled:
    "Rien n’a été confirmé : la fenêtre a été fermée, ou cet appareil n’a pas de clé d’accès pour ce pod.",
  readFailed: "Impossible d’obtenir une confirmation de votre pod.",
  ceremonyFailed: "Votre clé d’accès n’a pas pu signer la confirmation.",
  "noPasskey.title": "Ajoutez une clé d’accès pour approuver ici",
  "noPasskey.body":
    "Vous n’avez pas encore de clé d’accès sur ce pod. Ajoutez-en une dans Sécurité, puis réessayez.",
  "unsupported.body":
    "Ce navigateur ne peut pas utiliser de clé d’accès. Ouvrez l’administration du pod dans un navigateur qui le peut, ou approuvez dans Relay.",
  "relay.device": "Ou approuvez dans Relay sur {device}, avec Face ID.",
  "relay.any": "Ou approuvez dans Relay sur votre téléphone, avec Face ID.",
  addPasskey: "Ajouter une clé d’accès",
  declined: "Non approuvée : vous n’avez pas confirmé que c’est vous.",
};

/** The presence dialog's translator, in the ambient catalog locale. */
export function presenceT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

/**
 * "Add this device" (founder decision of 9 Nov 2026): the words of the new
 * device's panel (`panel.*`) and of the requests a device the person already
 * uses approves (`requests.*`), as catalogs (`@synap-core/types/i18n`).
 * English is the source and the type. DRAFT French ("vous"), awaiting the
 * founder's review.
 *
 * Device and browser names ("iPhone", "Safari") are proper nouns
 * (`device-label.ts`); only the joiner and the fallback are words here. A
 * request's label is what the new device sent: content, shown as written.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "label.join": "{device} · {browser}",
  "label.unknown": "This device",

  "panel.title": "Confirm from a device you already use",
  "panel.asking": "Asking your pod…",
  "panel.number.aria": "The number to pick: {number}",
  "panel.instruction":
    "On your computer or phone where you already confirm it’s you, open pod admin or Relay and pick {number}.",
  "panel.left.minutes":
    "{n, plural, one {# minute left} other {# minutes left}}",
  "panel.left.seconds":
    "{n, plural, one {# second left} other {# seconds left}}",
  "panel.cancel": "Cancel",
  "panel.statusFailed":
    "Couldn’t check whether it was approved. Your request is still waiting.",
  "panel.tryAgain": "Try again",
  "panel.copyDetails": "Copy details",
  "panel.copyDetails.aria": "Copy the technical details of this error",
  "panel.approved": "Approved. Create a passkey on this device to finish.",
  "panel.firstWay":
    "You have no way to confirm it’s you yet, so this device can add its passkey straight away.",
  "panel.create": "Create a passkey on this device",
  "panel.done": "This device can now confirm it’s you.",
  "panel.continue": "Continue",
  "panel.declined":
    "The request was declined. If it was you, ask again from here.",
  "panel.expired": "The request ran out of time. Ask again from here.",
  "panel.askAgain": "Ask again",
  "panel.requestFailed":
    "Couldn’t ask your pod. Check your connection, then try again.",
  "panel.rateLimited":
    "Too many requests to add a device. Wait 15 minutes, then ask again.",
  "panel.noSession":
    "This sign-in can’t be tied to a request. Sign in again on this device, then try again.",
  "panel.reauth":
    "Adding a passkey needs a recent sign-in. Sign in again, then set up this device again.",
  "panel.signInAgain": "Sign in again",
  "panel.create.refused": "Your pod didn’t accept the new passkey. Try again.",
  "panel.create.closed":
    "No passkey was created: the prompt was closed or didn’t open. Try again.",

  "requests.region": "Devices asking to confirm it’s you",
  "requests.title": "{label} asks to confirm it’s you",
  "requests.pick": "Pick the number it shows.",
  "requests.left": "{minutes} min left",
  "requests.number.aria": "Pick {number}",
  "requests.notMe": "Not me",
  "requests.subject": "Add {label} as a device that confirms it’s you",
  "requests.approved":
    "{label} can now confirm it’s you once it adds its passkey.",
  "requests.mismatch":
    "That wasn’t the number on the new device, so the request was declined.",
  "requests.gone": "That request is no longer waiting.",
  "requests.self":
    "Approve this from a device you already use, not from the one asking.",
  "requests.declined": "Declined. {label} can’t confirm it’s you.",
  "requests.failed": "Couldn’t approve it. Try again.",
  "requests.declineFailed": "Couldn’t decline it. Try again.",
  "requests.readFailed":
    "Couldn’t check for new devices asking to confirm it’s you.",
  "requests.retry": "Try again",
  "requests.dismiss": "Dismiss",
} as const;

export const fr: Catalog<typeof en> = {
  "label.join": "{device} · {browser}",
  "label.unknown": "Cet appareil",

  "panel.title": "Confirmez depuis un appareil que vous utilisez déjà",
  "panel.asking": "Demande à votre pod…",
  "panel.number.aria": "Le nombre à choisir : {number}",
  "panel.instruction":
    "Sur l’ordinateur ou le téléphone avec lequel vous confirmez déjà que c’est vous, ouvrez l’administration du pod ou Relay et choisissez {number}.",
  "panel.left.minutes":
    "{n, plural, one {Encore # minute} other {Encore # minutes}}",
  "panel.left.seconds":
    "{n, plural, one {Encore # seconde} other {Encore # secondes}}",
  "panel.cancel": "Annuler",
  "panel.statusFailed":
    "Impossible de vérifier si elle a été approuvée. Votre demande attend toujours.",
  "panel.tryAgain": "Réessayer",
  "panel.copyDetails": "Copier les détails",
  "panel.copyDetails.aria": "Copier les détails techniques de cette erreur",
  "panel.approved":
    "Approuvé. Créez une clé d’accès sur cet appareil pour terminer.",
  "panel.firstWay":
    "Vous n’avez encore aucun moyen de confirmer que c’est vous : cet appareil peut ajouter sa clé d’accès tout de suite.",
  "panel.create": "Créer une clé d’accès sur cet appareil",
  "panel.done": "Cet appareil peut désormais confirmer que c’est vous.",
  "panel.continue": "Continuer",
  "panel.declined":
    "La demande a été refusée. Si c’était vous, redemandez depuis cet appareil.",
  "panel.expired":
    "Le délai de la demande est écoulé. Redemandez depuis cet appareil.",
  "panel.askAgain": "Redemander",
  "panel.requestFailed":
    "Impossible de joindre votre pod. Vérifiez votre connexion, puis réessayez.",
  "panel.rateLimited":
    "Trop de demandes d’ajout d’appareil. Attendez 15 minutes, puis redemandez.",
  "panel.noSession":
    "Cette connexion ne peut pas être liée à une demande. Reconnectez-vous sur cet appareil, puis réessayez.",
  "panel.reauth":
    "Ajouter une clé d’accès demande une connexion récente. Reconnectez-vous, puis configurez de nouveau cet appareil.",
  "panel.signInAgain": "Se reconnecter",
  "panel.create.refused":
    "Votre pod n’a pas accepté la nouvelle clé d’accès. Réessayez.",
  "panel.create.closed":
    "Aucune clé d’accès n’a été créée : la fenêtre a été fermée ou ne s’est pas ouverte. Réessayez.",

  "requests.region": "Appareils qui demandent à confirmer que c’est vous",
  "requests.title": "{label} demande à confirmer que c’est vous",
  "requests.pick": "Choisissez le nombre qu’il affiche.",
  "requests.left": "Encore {minutes} min",
  "requests.number.aria": "Choisir {number}",
  "requests.notMe": "Ce n’est pas moi",
  "requests.subject":
    "Ajouter {label} aux appareils qui confirment que c’est vous",
  "requests.approved":
    "{label} pourra confirmer que c’est vous dès qu’il aura ajouté sa clé d’accès.",
  "requests.mismatch":
    "Ce n’était pas le nombre affiché sur le nouvel appareil : la demande a été refusée.",
  "requests.gone": "Cette demande n’attend plus.",
  "requests.self":
    "Approuvez-la depuis un appareil que vous utilisez déjà, pas depuis celui qui demande.",
  "requests.declined": "Refusé. {label} ne peut pas confirmer que c’est vous.",
  "requests.failed": "Impossible de l’approuver. Réessayez.",
  "requests.declineFailed": "Impossible de la refuser. Réessayez.",
  "requests.readFailed":
    "Impossible de vérifier si de nouveaux appareils demandent à confirmer que c’est vous.",
  "requests.retry": "Réessayer",
  "requests.dismiss": "Fermer",
};

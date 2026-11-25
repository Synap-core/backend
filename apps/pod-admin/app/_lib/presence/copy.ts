/**
 * The words of the proof-of-presence dialog, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. Client
 * words: a request, never a proposal. A sensitive action is named by its
 * title (`sensitiveActionTitle`, `@synap-core/types/presence`), never a
 * second word list here. DRAFT French, awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";
import { presenceWordsEn, presenceWordsFr } from "@synap-core/types/presence";

export const en = {
  // The shared presence words ("I lost my passkey", "Use a code instead"):
  // one wording on every surface.
  ...presenceWordsEn,
  title: "Confirm it’s you",
  "title.progress": "Confirm it’s you ({index} of {total})",
  action: "To approve “{action}”, confirm with your passkey.",
  "action.unnamed": "To approve this request, confirm with your passkey.",
  act: "Confirm “{doing}” with your passkey.",
  whyToggle: "Why?",
  why: "Some approvals need you in person, not only a signed-in browser: an app or an AI using your session can’t approve them for you. Your browser will ask for Touch ID, Windows Hello or your security key.",
  "why.act":
    "Some changes need you in person, not only a signed-in browser: an app or an AI using your session can’t make them for you. Your browser will ask for Touch ID, Windows Hello or your security key.",
  confirm: "Confirm with your passkey",
  notNow: "Not now",
  stopHere: "Stop here",
  tryAgain: "Try again",
  checking: "Getting a confirmation from your pod…",
  waiting: "Waiting for your passkey…",
  "again.invalid":
    "That passkey didn’t confirm it’s you. Use a passkey of this pod, and let your device ask for Touch ID, Windows Hello or its PIN.",
  "again.expired": "That confirmation took too long. Confirm again.",
  "again.used": "That confirmation was already used. Confirm again.",
  cancelled:
    "Nothing was confirmed: the prompt was closed, or this device has no passkey for this pod.",
  readFailed:
    "Couldn’t get a confirmation from your pod. Check your connection, then press Try again.",
  ceremonyFailed:
    "The passkey prompt ended with an error. Try again, or use another passkey.",
  copyDetails: "Copy details",
  copyDetailsA11y: "Copy the technical details of this error",
  // A password-manager extension took over the passkey prompt in this page
  // (`planAssertion`, `lib/passkey.ts`): the other prompt, after one failed.
  useDevice: "Use this device’s passkey",
  useManager: "Use your password manager",
  "fallback.device":
    "Nothing was confirmed. If your passkey is in {name} on this device, use this device’s passkey.",
  "fallback.device.unnamed":
    "Nothing was confirmed. If your passkey is on this device, use this device’s passkey.",
  "device.unreachable.mac":
    "This browser can’t reach the passkey on your Mac. Use Safari.",
  "device.unreachable":
    "This browser can’t reach the passkey on this device. Use another browser.",
  "device.closed.mac":
    "Nothing was confirmed. If the prompt didn’t offer your passkey, this browser can’t reach the passkey on your Mac. Use Safari.",
  "device.closed":
    "Nothing was confirmed. If the prompt didn’t offer your passkey, this browser can’t reach the passkey on this device. Use another browser.",
  // Why a new passkey could not be created (`PasskeyCreateFailed.reason`):
  // Settings › Security and the invite page.
  "create.exists":
    "A passkey for this pod is already there. Use that one, or choose another place for the new one.",
  "create.timeout": "The passkey prompt closed before it finished. Try again.",
  "create.failed":
    "The passkey couldn’t be created here. Try again, or choose another place for it.",
  "noPasskey.title": "Add a passkey to approve this here",
  "noPasskey.title.act": "Add a passkey to do this here",
  "noPasskey.body":
    "You have no passkey on this pod yet. Add one under Security, then try again.",
  "unsupported.body":
    "This browser can’t use a passkey. Open pod admin in a browser that can.",
  "relay.device": "Or approve it in Relay on {device}, with Face ID.",
  "relay.any": "Or approve it in Relay on your phone, with Face ID.",
  addPasskey: "Add a passkey",
  comeBack:
    "Add your passkey in the tab that opened, then come back here and press Try again.",
  declined: "Not approved: you didn’t confirm it’s you.",
  "declined.act": "Nothing changed: you didn’t confirm it’s you.",
  "doing.passkeyAdd": "Add a passkey to your account",
  "doing.passkeyRemove": "Remove a passkey from your account",
  "doing.modeOff": "Turn off approvals in person",
  "doing.sensitivityOff": "Stop asking for a passkey there",
  "passkeyChange.needsProof":
    "A passkey change needs a confirmation from your passkey.",
  "doing.recoveryCodes": "Create new recovery codes",
  "doing.totpAdd": "Add an authenticator app",
  confirmCode: "Confirm with this code",
  "code.label": "Code",
  "code.help":
    "The 6 digits your authenticator app shows, or one of your recovery codes. A recovery code works once.",
  "again.code":
    "That code didn’t confirm it’s you, or it was already used. Type the code your app shows now, or another recovery code.",
  usePasskey: "Use your passkey instead",
  // "Add this device" (founder, 9 Nov 2026): a device the person already
  // uses approves this one, which then creates its own passkey.
  setUp: "Set up this device",
  "setUp.done": "This device is set up. Confirm with its new passkey.",
};

const fr: Catalog<typeof en> = {
  ...presenceWordsFr,
  title: "Confirmez que c’est vous",
  "title.progress": "Confirmez que c’est vous ({index} sur {total})",
  action: "Pour approuver « {action} », confirmez avec votre clé d’accès.",
  "action.unnamed":
    "Pour approuver cette demande, confirmez avec votre clé d’accès.",
  act: "Confirmez « {doing} » avec votre clé d’accès.",
  whyToggle: "Pourquoi ?",
  why: "Certaines approbations demandent votre présence, pas seulement un navigateur connecté : une app ou une IA qui utilise votre session ne peut pas les approuver à votre place. Votre navigateur va demander Touch ID, Windows Hello ou votre clé de sécurité.",
  "why.act":
    "Certaines modifications demandent votre présence, pas seulement un navigateur connecté : une app ou une IA qui utilise votre session ne peut pas les faire à votre place. Votre navigateur va demander Touch ID, Windows Hello ou votre clé de sécurité.",
  confirm: "Confirmer avec votre clé d’accès",
  notNow: "Pas maintenant",
  stopHere: "Arrêter ici",
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
  readFailed:
    "Impossible d’obtenir une confirmation de votre pod. Vérifiez votre connexion, puis appuyez sur Réessayer.",
  ceremonyFailed:
    "La fenêtre de la clé d’accès s’est arrêtée sur une erreur. Réessayez, ou utilisez une autre clé d’accès.",
  copyDetails: "Copier les détails",
  copyDetailsA11y: "Copier les détails techniques de cette erreur",
  useDevice: "Utiliser la clé d’accès de cet appareil",
  useManager: "Utiliser votre gestionnaire de mots de passe",
  "fallback.device":
    "Rien n’a été confirmé. Si votre clé d’accès est dans {name} sur cet appareil, utilisez la clé d’accès de cet appareil.",
  "fallback.device.unnamed":
    "Rien n’a été confirmé. Si votre clé d’accès est sur cet appareil, utilisez la clé d’accès de cet appareil.",
  "device.unreachable.mac":
    "Ce navigateur ne peut pas atteindre la clé d’accès de votre Mac. Utilisez Safari.",
  "device.unreachable":
    "Ce navigateur ne peut pas atteindre la clé d’accès de cet appareil. Utilisez un autre navigateur.",
  "device.closed.mac":
    "Rien n’a été confirmé. Si la fenêtre ne proposait pas votre clé d’accès, ce navigateur ne peut pas atteindre la clé d’accès de votre Mac. Utilisez Safari.",
  "device.closed":
    "Rien n’a été confirmé. Si la fenêtre ne proposait pas votre clé d’accès, ce navigateur ne peut pas atteindre la clé d’accès de cet appareil. Utilisez un autre navigateur.",
  "create.exists":
    "Une clé d’accès pour ce pod s’y trouve déjà. Utilisez-la, ou choisissez un autre endroit pour la nouvelle.",
  "create.timeout":
    "La fenêtre de la clé d’accès s’est fermée avant la fin. Réessayez.",
  "create.failed":
    "La clé d’accès n’a pas pu être créée ici. Réessayez, ou choisissez un autre endroit pour elle.",
  "noPasskey.title": "Ajoutez une clé d’accès pour approuver ici",
  "noPasskey.title.act": "Ajoutez une clé d’accès pour le faire ici",
  "noPasskey.body":
    "Vous n’avez pas encore de clé d’accès sur ce pod. Ajoutez-en une dans Sécurité, puis réessayez.",
  "unsupported.body":
    "Ce navigateur ne peut pas utiliser de clé d’accès. Ouvrez l’administration du pod dans un navigateur qui le peut.",
  "relay.device": "Ou approuvez dans Relay sur {device}, avec Face ID.",
  "relay.any": "Ou approuvez dans Relay sur votre téléphone, avec Face ID.",
  addPasskey: "Ajouter une clé d’accès",
  comeBack:
    "Ajoutez votre clé d’accès dans l’onglet qui s’est ouvert, puis revenez ici et appuyez sur Réessayer.",
  declined: "Non approuvée : vous n’avez pas confirmé que c’est vous.",
  "declined.act": "Rien n’a changé : vous n’avez pas confirmé que c’est vous.",
  "doing.passkeyAdd": "Ajouter une clé d’accès à votre compte",
  "doing.passkeyRemove": "Retirer une clé d’accès de votre compte",
  "doing.modeOff": "Désactiver les approbations en personne",
  "doing.sensitivityOff": "Ne plus demander de clé d’accès à cet endroit",
  "passkeyChange.needsProof":
    "Modifier une clé d’accès demande une confirmation avec votre clé d’accès.",
  "doing.recoveryCodes": "Créer de nouveaux codes de récupération",
  "doing.totpAdd": "Ajouter une app d’authentification",
  confirmCode: "Confirmer avec ce code",
  "code.label": "Code",
  "code.help":
    "Les 6 chiffres affichés par votre app d’authentification, ou l’un de vos codes de récupération. Un code de récupération ne sert qu’une fois.",
  "again.code":
    "Ce code n’a pas confirmé que c’est vous, ou il a déjà servi. Saisissez le code affiché maintenant par votre app, ou un autre code de récupération.",
  usePasskey: "Utiliser plutôt votre clé d’accès",
  setUp: "Configurer cet appareil",
  "setUp.done":
    "Cet appareil est configuré. Confirmez avec sa nouvelle clé d’accès.",
};

/** The presence dialog's translator, in the ambient catalog locale. */
export function presenceT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

/**
 * The words of "I lost my passkey" (the recovery ladder), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";
import { PRESENCE_WORDS } from "@synap-core/types/presence";

const pageEn = {
  intro:
    "When you can no longer confirm it’s you (a lost passkey, phone or password manager), you can reset how you confirm it. For your safety this takes 24 hours: every device of yours is told, and any of them can cancel it.",
  email:
    "An email is never enough here: an app or an AI that reads your mail could use it.",
  "none.ask": "Ask for a reset",
  "none.cancelled": "Your last reset was cancelled {when}.",
  "ask.title": "Ask for a reset?",
  "ask.consequence":
    "Every device of yours is told now. In 24 hours you can finish it here, after signing in again. Until then, any of your signed-in devices can cancel it.",
  "ask.confirm": "Ask for a reset",
  "waiting.title": "A reset is waiting",
  "waiting.body":
    "You can finish it from {when}. Every device of yours was told. If you didn’t ask for it, cancel it now.",
  "waiting.cancel": "Cancel the reset",
  "ready.title": "Your reset is ready",
  "ready.body":
    "Finishing removes every way you confirm it’s you on this pod: your passkeys stop counting, and your Face ID and Touch ID keys, your authenticator app and your recovery codes are removed. Then you add a passkey again.",
  "ready.finish": "Finish the reset",
  "ready.confirm.title": "Finish the reset?",
  "ready.confirm.consequence":
    "Every way you confirm it’s you is removed now, and your other browsers are signed out (this one stays). Every device of yours is told.",
  "ready.confirm": "Finish",
  "ready.signIn":
    "Sign in again with your password or an email code, then finish within 10 minutes.",
  "ready.signInAction": "Sign in again",
  "done.title": "Reset finished",
  "done.body":
    "Add a passkey now, then a second way in, so losing one never locks you out again.",
  "done.addPasskey": "Add a passkey",
  "done.addSecond": "Add an authenticator app or recovery codes",
  "done.signOutFailed":
    "Some of your other browsers may still be signed in. Sign out in each of them.",
  signedOut: "Sign in to this pod first.",
  signIn: "Sign in",
  failed: "Couldn’t read your reset.",
  retry: "Try again",
  notChanged: "Nothing changed.",
} as const;

const pageFr: Catalog<typeof pageEn> = {
  intro:
    "Si vous ne pouvez plus confirmer que c’est vous (clé d’accès, téléphone ou gestionnaire de mots de passe perdu), vous pouvez réinitialiser vos moyens de confirmation. Par sécurité, cela prend 24 heures : chacun de vos appareils est informé, et n’importe lequel peut l’annuler.",
  email:
    "Un e-mail ne suffit jamais ici : une app ou une IA qui lit votre messagerie pourrait s’en servir.",
  "none.ask": "Demander une réinitialisation",
  "none.cancelled": "Votre dernière réinitialisation a été annulée {when}.",
  "ask.title": "Demander une réinitialisation ?",
  "ask.consequence":
    "Chacun de vos appareils est informé maintenant. Dans 24 heures, vous pourrez la terminer ici, après vous être reconnecté. D’ici là, n’importe lequel de vos appareils connectés peut l’annuler.",
  "ask.confirm": "Demander une réinitialisation",
  "waiting.title": "Une réinitialisation est en attente",
  "waiting.body":
    "Vous pourrez la terminer à partir de {when}. Chacun de vos appareils a été informé. Si vous ne l’avez pas demandée, annulez-la maintenant.",
  "waiting.cancel": "Annuler la réinitialisation",
  "ready.title": "Votre réinitialisation est prête",
  "ready.body":
    "Terminer retire tous vos moyens de confirmer que c’est vous sur ce pod : vos clés d’accès ne comptent plus, et vos clés Face ID et Touch ID, votre app d’authentification et vos codes de récupération sont retirés. Vous ajoutez ensuite une nouvelle clé d’accès.",
  "ready.finish": "Terminer la réinitialisation",
  "ready.confirm.title": "Terminer la réinitialisation ?",
  "ready.confirm.consequence":
    "Tous vos moyens de confirmer que c’est vous sont retirés maintenant, et vos autres navigateurs sont déconnectés (celui-ci reste connecté). Chacun de vos appareils est informé.",
  "ready.confirm": "Terminer",
  "ready.signIn":
    "Reconnectez-vous avec votre mot de passe ou un code par e-mail, puis terminez dans les 10 minutes.",
  "ready.signInAction": "Se reconnecter",
  "done.title": "Réinitialisation terminée",
  "done.body":
    "Ajoutez maintenant une clé d’accès, puis un deuxième moyen d’accès, pour qu’en perdre un ne vous bloque plus jamais.",
  "done.addPasskey": "Ajouter une clé d’accès",
  "done.addSecond":
    "Ajouter une app d’authentification ou des codes de récupération",
  "done.signOutFailed":
    "Certains de vos autres navigateurs sont peut-être encore connectés. Déconnectez-les depuis chacun d’eux.",
  signedOut: "Connectez-vous d’abord à ce pod.",
  signIn: "Se connecter",
  failed: "Impossible de lire votre réinitialisation.",
  retry: "Réessayer",
  notChanged: "Rien n’a changé.",
};

export const en = { ...PRESENCE_WORDS.en, ...pageEn };
export const fr: Catalog<typeof en> = { ...PRESENCE_WORDS.fr, ...pageFr };

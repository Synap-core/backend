/**
 * Pod security's words for the proof-of-presence mode, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. The
 * setting's name, its on/off words, what is sensitive and where to approve
 * are the shared presence words (`PRESENCE_WORDS`), merged in here, never
 * written twice. DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";
import { PRESENCE_WORDS } from "@synap-core/types/presence";

const cardEn = {
  "presence.hint": "{sensitive} need you in person. {where}",
  "presence.line.on":
    "An app or an AI using a signed-in session can’t approve a sensitive request, or change keys and rules, on its own.",
  "presence.line.off":
    "Sensitive approvals and changes still go through without a proof. The pod records each one.",
  "presence.source.env":
    "This pod’s operator turned it on in the pod’s environment. It can’t be turned off here.",
  "presence.source.changed": "Changed {when}.",
  "presence.source.default": "On by default.",
  "presence.missing.none":
    "Nothing went through without a proof in the last 30 days.",
  "presence.missing.wouldRefuse":
    "In the last 30 days, {n, plural, one {# approval or change} other {# approvals or changes}} went through without a proof. With this on, the pod refuses {n, plural, one {it} other {them}}.",
  "presence.missing.before":
    "In the last 30 days, {n, plural, one {# approval or change} other {# approvals or changes}} went through without a proof.",
  "presence.missing.showAll": "Show all {n}",
  "presence.on.title": "Turn on approvals in person?",
  "presence.on.consequence":
    "You have no passkey or Relay Face ID yet. Turning it off again needs one, so add a passkey first.",
  "presence.on.addPasskey": "Add a passkey",
  "presence.on.confirm": "Turn on",
  "presence.off.title": "Turn off approvals in person?",
  "presence.off.consequence":
    "Sensitive approvals and changes will go through without a proof again. You confirm with your passkey, and every pod admin is told that you turned it off.",
  "presence.off.confirm": "Turn off",
  "presence.failed": "Couldn’t read whether approvals need you in person.",
  "presence.retry": "Try again",
  "presence.notChanged": "Couldn’t change it",
  "presence.notChangedHint": "Nothing changed.",
} as const;

const cardFr: Catalog<typeof cardEn> = {
  "presence.hint": "{sensitive} demandent votre présence. {where}",
  "presence.line.on":
    "Une app ou une IA qui utilise une session connectée ne peut pas approuver une demande sensible, ni modifier des clés et des règles, seule.",
  "presence.line.off":
    "Les approbations et modifications sensibles passent encore sans preuve. Le pod enregistre chacune.",
  "presence.source.env":
    "L’opérateur de ce pod l’a activé dans l’environnement du pod. Il ne peut pas être désactivé ici.",
  "presence.source.changed": "Modifié {when}.",
  "presence.source.default": "Activé par défaut.",
  "presence.missing.none":
    "Rien n’est passé sans preuve ces 30 derniers jours.",
  "presence.missing.wouldRefuse":
    "Ces 30 derniers jours, {n, plural, one {# approbation ou modification est passée} other {# approbations ou modifications sont passées}} sans preuve. Activé, le pod {n, plural, one {la refuse} other {les refuse}}.",
  "presence.missing.before":
    "Ces 30 derniers jours, {n, plural, one {# approbation ou modification est passée} other {# approbations ou modifications sont passées}} sans preuve.",
  "presence.missing.showAll": "Tout afficher ({n})",
  "presence.on.title": "Activer les approbations en personne ?",
  "presence.on.consequence":
    "Vous n’avez pas encore de clé d’accès ni Face ID dans Relay. Pour désactiver ensuite, il en faudra une : ajoutez d’abord une clé d’accès.",
  "presence.on.addPasskey": "Ajouter une clé d’accès",
  "presence.on.confirm": "Activer",
  "presence.off.title": "Désactiver les approbations en personne ?",
  "presence.off.consequence":
    "Les approbations et modifications sensibles passeront de nouveau sans preuve. Vous confirmez avec votre clé d’accès, et chaque administrateur du pod est prévenu que vous l’avez désactivé.",
  "presence.off.confirm": "Désactiver",
  "presence.failed":
    "Impossible de savoir si les approbations demandent votre présence.",
  "presence.retry": "Réessayer",
  "presence.notChanged": "Impossible de le modifier",
  "presence.notChangedHint": "Rien n’a changé.",
};

export const en = { ...PRESENCE_WORDS.en, ...cardEn };
export const fr: Catalog<typeof en> = { ...PRESENCE_WORDS.fr, ...cardFr };

/**
 * Pod security's words for the proof-of-presence mode (W3 slice 3), as
 * catalogs (`@synap-core/types/i18n`): English is the source and the type.
 * DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "presence.title": "Approvals need you in person",
  "presence.hint":
    "Sensitive approvals and changes need your passkey or Face ID, not only a signed-in browser.",
  "presence.mark.on": "On",
  "presence.mark.off": "Recording only",
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
  "presence.missing.showAll": "Show all",
  "presence.switch": "Approvals need you in person",
  "presence.on.title": "Turn on approvals in person?",
  "presence.on.consequence":
    "Sensitive approvals and changes will need your passkey here, or Face ID in Relay. Turning it off again needs one too: check that you have a passkey or Relay’s Face ID before you turn it on.",
  "presence.on.passkeys": "Check your passkeys",
  "presence.on.confirm": "Turn on",
  "presence.off.title": "Turn off approvals in person?",
  "presence.off.consequence":
    "Sensitive approvals and changes will go through without a proof again. You confirm with your passkey, and every pod admin is told that you turned it off.",
  "presence.off.confirm": "Turn off",
  "presence.failed": "Couldn’t read whether approvals need you in person.",
  "presence.retry": "Try again",
  "presence.notChanged": "Couldn’t change it",
  "presence.notChangedHint": "Nothing changed. Try again.",
};

export const fr: Catalog<typeof en> = {
  "presence.title": "Les approbations demandent votre présence",
  "presence.hint":
    "Les approbations et modifications sensibles demandent votre clé d’accès ou Face ID, pas seulement un navigateur connecté.",
  "presence.mark.on": "Activé",
  "presence.mark.off": "Enregistrement seul",
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
  "presence.missing.showAll": "Tout afficher",
  "presence.switch": "Les approbations demandent votre présence",
  "presence.on.title": "Activer les approbations en personne ?",
  "presence.on.consequence":
    "Les approbations et modifications sensibles demanderont votre clé d’accès ici, ou Face ID dans Relay. Pour désactiver ensuite, il en faudra une aussi : vérifiez que vous avez une clé d’accès ou Face ID dans Relay avant d’activer.",
  "presence.on.passkeys": "Vérifier vos clés d’accès",
  "presence.on.confirm": "Activer",
  "presence.off.title": "Désactiver les approbations en personne ?",
  "presence.off.consequence":
    "Les approbations et modifications sensibles passeront de nouveau sans preuve. Vous confirmez avec votre clé d’accès, et chaque administrateur du pod est prévenu que vous l’avez désactivé.",
  "presence.off.confirm": "Désactiver",
  "presence.failed":
    "Impossible de savoir si les approbations demandent votre présence.",
  "presence.retry": "Réessayer",
  "presence.notChanged": "Impossible de le modifier",
  "presence.notChangedHint": "Rien n’a changé. Réessayez.",
};

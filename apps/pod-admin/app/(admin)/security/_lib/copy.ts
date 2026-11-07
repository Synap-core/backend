/**
 * Pod security's words for the proof-of-presence mode and what asks
 * for a passkey, as catalogs
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
    "You have fewer than two ways to confirm it’s you. The pod turns it on only with two, so losing one never locks you out.",
  "presence.addSecond": "Add a 2FA app or recovery codes",
  "presence.twoWays.refused":
    "Not turned on: add a second way to confirm it’s you first.",
  "presence.on.confirm": "Turn on",
  "presence.off.title": "Turn off approvals in person?",
  "presence.off.consequence":
    "Sensitive approvals and changes will go through without a proof again. You confirm with your passkey, and every pod admin is told that you turned it off.",
  "presence.off.confirm": "Turn off",
  "presence.failed": "Couldn’t read whether approvals need you in person.",
  "presence.retry": "Try again",
  "presence.notChanged": "Couldn’t change it",
  "presence.notChangedHint": "Nothing changed.",
  "sensitivity.title": "What asks for your passkey",
  "sensitivity.hint":
    "Switch off what a signed-in session may do here without your passkey. Switching one off asks for your passkey, and every pod admin is told.",
  "sensitivity.mark": "{asking} of {total} ask",
  "sensitivity.reportNote":
    "Approvals need you in person is off: what is switched on here is recorded, not refused.",
  "sensitivity.reason.deploy": "Deploys",
  "sensitivity.reason.setup": "Connecting apps, AIs and keys",
  "sensitivity.reason.governance": "Who may do what",
  "sensitivity.reason.deletion": "Deleting and archiving",
  "sensitivity.group.count": "{asking} of {total} ask",
  "sensitivity.kind.approval": "Approve",
  "sensitivity.kind.action": "Do yourself",
  "sensitivity.row.prefix": "Any {name} request",
  "sensitivity.row.switch": "Ask for a passkey: {label}",
  "sensitivity.showAll": "Show all {n}",
  "sensitivity.showFewer": "Show fewer",
  "sensitivity.reset": "Ask for everything again",
  "sensitivity.failed": "Couldn’t read what asks for your passkey.",
  "sensitivity.retry": "Try again",
  "sensitivity.notChanged": "Couldn’t change it",
  "sensitivity.notChangedHint": "Nothing changed.",
  "sensitivity.changedBy": "Changed {when}.",
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
    "Vous avez moins de deux moyens de confirmer que c’est vous. Le pod ne l’active qu’avec deux, pour qu’en perdre un ne vous bloque jamais.",
  "presence.addSecond":
    "Ajouter une app de double authentification ou des codes de récupération",
  "presence.twoWays.refused":
    "Pas activé : ajoutez d’abord un deuxième moyen de confirmer que c’est vous.",
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
  "sensitivity.title": "Ce qui demande votre clé d’accès",
  "sensitivity.hint":
    "Désactivez ce qu’une session connectée peut faire ici sans votre clé d’accès. Désactiver demande votre clé d’accès, et chaque administrateur du pod est prévenu.",
  "sensitivity.mark":
    "{asking, plural, one {# sur {total} demande} other {# sur {total} demandent}}",
  "sensitivity.reportNote":
    "Les approbations en personne sont désactivées : ce qui est activé ici est enregistré, pas refusé.",
  "sensitivity.reason.deploy": "Déploiements",
  "sensitivity.reason.setup": "Connexion d’apps, d’IA et de clés",
  "sensitivity.reason.governance": "Qui peut faire quoi",
  "sensitivity.reason.deletion": "Suppression et archivage",
  "sensitivity.group.count": "{asking} sur {total}",
  "sensitivity.kind.approval": "Approuver",
  "sensitivity.kind.action": "Faire vous-même",
  "sensitivity.row.prefix": "Toute demande {name}",
  "sensitivity.row.switch": "Demander une clé d’accès : {label}",
  "sensitivity.showAll": "Tout afficher ({n})",
  "sensitivity.showFewer": "Afficher moins",
  "sensitivity.reset": "Tout redemander",
  "sensitivity.failed": "Impossible de lire ce qui demande votre clé d’accès.",
  "sensitivity.retry": "Réessayer",
  "sensitivity.notChanged": "Impossible de le modifier",
  "sensitivity.notChangedHint": "Rien n’a changé.",
  "sensitivity.changedBy": "Modifié {when}.",
};

export const en = { ...PRESENCE_WORDS.en, ...cardEn };
export const fr: Catalog<typeof en> = { ...PRESENCE_WORDS.fr, ...cardFr };

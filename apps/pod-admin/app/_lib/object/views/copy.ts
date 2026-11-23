/**
 * Words of the object views, as catalogs (`@synap-core/types/i18n`): English
 * is the source and the type. DRAFT French, awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "agent.trust.change": "What it may do in each space",
  "agent.trust.askAdmin":
    "An admin of your company’s Synap can change what it may do without asking.",
  "agent.writes.saved": "Changed: {mode}",
  "agent.writes.failed": "Couldn’t change how its writes land",
  "agent.writes.failedHint": "Nothing changed. Try again.",
  "agent.writes.whoMay":
    "Only the person who connected it, or a pod admin, can change this.",
  "agent.writes.space": "In {space}: {mode}",
  "agent.writes.spacesNote": "A space’s own setting wins inside that space.",
  "agent.writes.podDefault": "Change the pod default in Settings",
  "agent.writes.computerDecides":
    "The computer it runs on is set to “{mode}”, which is stricter, so its writes follow the computer.",
  "tool.approvals.title": "When an AI uses it",
  "tool.approvals.whole": "Every AI, every action",
  "tool.approvals.wholeAria": "How every action of {tool} runs for every AI",
  "tool.approvals.actionAria": "How {action} runs for every AI",
  "tool.approvals.exceptions":
    "Exceptions ({count}): they win over the setting above for that agent or space.",
  "tool.approvals.failed": "Its approvals couldn’t be read.",
  "tool.approvals.modeFailed": "How it runs couldn’t be read.",
  "tool.approvals.retry": "Retry",
  "tool.approvals.agentDoor": "Its agent",
  "tool.approvals.notChanged": "The pod didn’t change how it runs.",
  "tool.approvals.whoSets": "A pod admin sets how it runs for every AI.",
  "tool.approvals.all": "Every approval on this tool",
  "agent.approvals.title": "What it may do",
  "agent.approvals.rows": "Its own approvals",
  "agent.approvals.none":
    "No approval of its own. It follows the approvals for every AI and its posture above.",
  "agent.approvals.failed": "Its approvals couldn’t be read.",
  "agent.approvals.retry": "Retry",
  "agent.approvals.tool": "Its tool",
  "agent.approvals.all": "All its approvals",
  "session.lineage.partOf": "Part of",
  "session.lineage.parentFailed": "Couldn’t read what it is part of",
  "session.subSessions.title": "Sub-sessions",
  "session.subSessions.failed": "Its sub-sessions couldn’t be read.",
  "session.subSessions.showAll": "Show all {n} sub-sessions",
  "session.subSessions.restFailed": "The other sub-sessions couldn’t be read.",
  "nextStep.title": "Next step",
  "nextStep.proposed": "Sent for review: it changes once someone approves it.",
  "nextStep.failed": "That didn’t work",
  "made.title": "Made",
  "made.showAll": "Show all {n}",
} as const;

export const fr: Catalog<typeof en> = {
  "agent.trust.change": "Ce qu’il peut faire dans chaque espace",
  "agent.trust.askAdmin":
    "Un administrateur du Synap de votre entreprise peut changer ce qu’il peut faire sans demander.",
  "agent.writes.saved": "Modifié\u00a0: {mode}",
  "agent.writes.failed":
    "Impossible de changer la façon dont ses écritures s’appliquent",
  "agent.writes.failedHint": "Rien n’a changé. Réessayez.",
  "agent.writes.whoMay":
    "Seule la personne qui l’a connecté, ou un administrateur du pod, peut changer cela.",
  "agent.writes.space": "Dans {space}\u00a0: {mode}",
  "agent.writes.spacesNote":
    "Le réglage propre à un espace l’emporte dans cet espace.",
  "agent.writes.podDefault":
    "Changer le réglage par défaut du pod dans Réglages",
  "agent.writes.computerDecides":
    "L’ordinateur sur lequel il tourne est réglé sur «\u00a0{mode}\u00a0», plus strict\u00a0: ses écritures suivent l’ordinateur.",
  "tool.approvals.title": "Quand une IA l’utilise",
  "tool.approvals.whole": "Toutes les IA, toutes les actions",
  "tool.approvals.wholeAria":
    "Comment chaque action de {tool} s’exécute pour toutes les IA",
  "tool.approvals.actionAria": "Comment {action} s’exécute pour toutes les IA",
  "tool.approvals.exceptions":
    "Exceptions ({count})\u00a0: elles l’emportent sur le réglage ci-dessus pour cet agent ou cet espace.",
  "tool.approvals.failed": "Ses approbations n’ont pas pu être lues.",
  "tool.approvals.modeFailed": "Son mode d’exécution n’a pas pu être lu.",
  "tool.approvals.retry": "Réessayer",
  "tool.approvals.agentDoor": "Son agent",
  "tool.approvals.notChanged": "Le pod n’a pas changé son mode d’exécution.",
  "tool.approvals.whoSets":
    "Un administrateur du pod règle son mode pour toutes les IA.",
  "tool.approvals.all": "Toutes les approbations de cet outil",
  "agent.approvals.title": "Ce qu’il peut faire",
  "agent.approvals.rows": "Ses propres approbations",
  "agent.approvals.none":
    "Aucune approbation propre. Il suit les approbations de toutes les IA et sa posture ci-dessus.",
  "agent.approvals.failed": "Ses approbations n’ont pas pu être lues.",
  "agent.approvals.retry": "Réessayer",
  "agent.approvals.tool": "Son outil",
  "agent.approvals.all": "Toutes ses approbations",
  "session.lineage.partOf": "Fait partie de",
  "session.lineage.parentFailed": "Impossible de lire ce dont elle fait partie",
  "session.subSessions.title": "Sous-sessions",
  "session.subSessions.failed": "Ses sous-sessions n’ont pas pu être lues.",
  "session.subSessions.showAll": "Voir les {n} sous-sessions",
  "session.subSessions.restFailed":
    "Les autres sous-sessions n’ont pas pu être lues.",
  "nextStep.title": "Prochaine étape",
  "nextStep.proposed":
    "Envoyé pour revue : cela change une fois que quelqu’un l’approuve.",
  "nextStep.failed": "Cela n’a pas fonctionné",
  "made.title": "Créé ou modifié",
  "made.showAll": "Voir les {n}",
};

/** The object views' translator, in the ambient catalog locale. */
export function objectViewsT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

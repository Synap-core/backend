/**
 * The computer page's words for "What agents on this computer may do"
 * (plan 07ecf0be item 1), as catalogs (`@synap-core/types/i18n`): English is
 * the source and the type. The mode names and their one-sentence lines come
 * from `AGENT_WRITE_MODE_CHOICES` (@synap-core/types/agents), never from here.
 * DRAFT French ("vous"), awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "writes.title": "What agents on this computer may do",
  "writes.ceiling":
    "Every agent on {computer} does at most this, whatever its own setting allows.",
  "writes.whoMay":
    "Only the person who connected this computer, or a pod admin, can change this.",
  "writes.loadFailed": "Couldn’t load what agents on it may do.",
  "writes.retry": "Retry",
  "writes.held":
    "{n, plural, one {# agent on it asks more because of this computer.} other {# agents on it ask more because of this computer.}}",
  "writes.confirm.title": "Set {computer} to {mode}?",
  "writes.confirm.changes":
    "{n, plural, =0 {No agent on it changes now.} one {This changes how # of its agents’ changes land.} other {This changes how # of its agents’ changes land.}} Agents added to it later follow it too.",
  "writes.confirm.uncounted":
    "Couldn’t read every agent on it, so the number it changes is not known. Agents added to it later follow it too.",
  "writes.confirm.counting":
    "Still reading its agents. Agents added to it later follow it too.",
  "writes.confirm.action": "Change it",
  "writes.saved": "{computer}: {mode}",
  "writes.failed": "Couldn’t change this",
  "writes.failedHint": "Nothing changed. Try again.",
  "agent.mode.computer": "{mode}, inherited from this computer",
  "agent.mode.agent": "{mode}, set on the agent",
  "agent.mode.podDefault": "{mode}, the pod default",
  "agent.mode.failed": "Couldn’t read how its writes land",
  "rules.show": "Show the rules",
  "rules.hide": "Hide the rules",
  "rules.loadFailed": "Couldn’t load the rules.",
  "rules.none": "No rule names this computer or its agents.",
  "rules.source.computer": "This computer",
  "rules.source.allComputers": "All computers",
  "rules.source.agent": "{name}",
  "rules.source.agentClass": "Every {service} agent",
  "rules.source.pod": "Pod default",
  "rules.count": "{n, plural, one {# rule} other {# rules}}",
  "rules.inSpace": "{what} · in {space}",
  "rules.inAnySpace": "{what} · in a space",
  "rules.showAll": "Show all {n}",
  "rules.target.reversible": "Everything that can be undone",
  "rules.target.ownOrganise": "Tidying its own new work",
  "rules.target.everything": "Everything",
  "list.key": "Key",
  "list.showThem": "Show them",
  "list.loadFailed": "Couldn't load computers.",
  "list.empty":
    "A computer appears here the first time an agent connects from it. To add one, run this on that machine:",
  "list.moreAgents": "{n, plural, one {# more agent} other {# more agents}}",
  "model.runsAgents": "Runs {n, plural, one {# agent} other {# agents}}",
  "model.roster":
    "{agents, plural, one {# agent} other {# agents}} on {computers, plural, one {# computer} other {# computers}}",
  "model.expired":
    "{n, plural, one {One computer's key has expired} other {# computers' keys have expired}}",
  "model.expiredReconnect":
    "{n, plural, one {Its agents can't reach the pod until it has a fresh key. Run this on that computer:} other {Their agents can't reach the pod until each has a fresh key. Run this on each of those computers:}}",
  "model.seedsRevoked":
    "{n, plural, one {# approval it had inherited from its agent was taken back.} other {# approvals it had inherited from its agent were taken back.}}",
  "obj.rename": "Rename",
  "obj.lifetime": "Change key lifetime",
  "obj.revokingWaiting":
    "Revoking {name} is waiting for review. Nothing has been revoked yet.",
  "obj.openReview": "Open in Review",
  "obj.belongsUnset": "Not set yet. Choose one.",
  "obj.agentsTitle": "Agents on this computer",
  "obj.showAllAgents": "Show all {n} agents",
} as const;

export const fr: Catalog<typeof en> = {
  "writes.title": "Ce que les agents de cet ordinateur peuvent faire",
  "writes.ceiling":
    "Chaque agent de {computer} fait au plus ceci, quel que soit son propre réglage.",
  "writes.whoMay":
    "Seule la personne qui a connecté cet ordinateur, ou un administrateur du pod, peut changer ceci.",
  "writes.loadFailed": "Impossible de charger ce que ses agents peuvent faire.",
  "writes.retry": "Réessayer",
  "writes.held":
    "{n, plural, one {# agent dessus demande davantage à cause de cet ordinateur.} other {# agents dessus demandent davantage à cause de cet ordinateur.}}",
  "writes.confirm.title": "Passer {computer} en {mode} ?",
  "writes.confirm.changes":
    "{n, plural, =0 {Aucun de ses agents ne change maintenant.} one {Cela change la façon dont les modifications de # de ses agents s’appliquent.} other {Cela change la façon dont les modifications de # de ses agents s’appliquent.}} Les agents ajoutés plus tard le suivent aussi.",
  "writes.confirm.uncounted":
    "Impossible de lire chacun de ses agents : le nombre qui change n’est pas connu. Les agents ajoutés plus tard le suivent aussi.",
  "writes.confirm.counting":
    "Lecture de ses agents en cours. Les agents ajoutés plus tard le suivent aussi.",
  "writes.confirm.action": "Le changer",
  "writes.saved": "{computer} : {mode}",
  "writes.failed": "Impossible de changer ceci",
  "writes.failedHint": "Rien n’a changé. Réessayez.",
  "agent.mode.computer": "{mode}, hérité de cet ordinateur",
  "agent.mode.agent": "{mode}, réglé sur l’agent",
  "agent.mode.podDefault": "{mode}, le réglage du pod",
  "agent.mode.failed": "Impossible de lire comment ses écritures s’appliquent",
  "rules.show": "Afficher les règles",
  "rules.hide": "Masquer les règles",
  "rules.loadFailed": "Impossible de charger les règles.",
  "rules.none": "Aucune règle ne vise cet ordinateur ni ses agents.",
  "rules.source.computer": "Cet ordinateur",
  "rules.source.allComputers": "Tous les ordinateurs",
  "rules.source.agent": "{name}",
  "rules.source.agentClass": "Chaque agent {service}",
  "rules.source.pod": "Réglage du pod",
  "rules.count": "{n, plural, one {# règle} other {# règles}}",
  "rules.inSpace": "{what} · dans {space}",
  "rules.inAnySpace": "{what} · dans un espace",
  "rules.showAll": "Tout afficher ({n})",
  "rules.target.reversible": "Tout ce qui peut être annulé",
  "rules.target.ownOrganise": "Ranger son propre travail récent",
  "rules.target.everything": "Tout",
  "list.key": "Clé",
  "list.showThem": "Les afficher",
  "list.loadFailed": "Impossible de charger les ordinateurs.",
  "list.empty":
    "Un ordinateur apparaît ici dès qu’un agent s’y connecte pour la première fois. Pour en ajouter un, exécutez ceci sur cette machine :",
  "list.moreAgents":
    "{n, plural, one {# agent de plus} other {# agents de plus}}",
  "model.runsAgents":
    "Fait tourner {n, plural, one {# agent} other {# agents}}",
  "model.roster":
    "{agents, plural, one {# agent} other {# agents}} sur {computers, plural, one {# ordinateur} other {# ordinateurs}}",
  "model.expired":
    "{n, plural, one {La clé d’un ordinateur a expiré} other {Les clés de # ordinateurs ont expiré}}",
  "model.expiredReconnect":
    "{n, plural, one {Ses agents ne peuvent pas joindre le pod tant qu’il n’a pas une nouvelle clé. Exécutez ceci sur cet ordinateur :} other {Leurs agents ne peuvent pas joindre le pod tant que chacun n’a pas une nouvelle clé. Exécutez ceci sur chacun de ces ordinateurs :}}",
  "model.seedsRevoked":
    "{n, plural, one {# approbation héritée de son agent a été reprise.} other {# approbations héritées de son agent ont été reprises.}}",
  "obj.rename": "Renommer",
  "obj.lifetime": "Changer la durée de la clé",
  "obj.revokingWaiting":
    "La révocation de {name} attend une revue. Rien n’a encore été révoqué.",
  "obj.openReview": "Ouvrir dans Demandes",
  "obj.belongsUnset": "Pas encore défini. Choisissez-en un.",
  "obj.agentsTitle": "Agents sur cet ordinateur",
  "obj.showAllAgents": "Voir les {n} agents",
};

/** The words' translator, in the ambient catalog locale. */
export function computersT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

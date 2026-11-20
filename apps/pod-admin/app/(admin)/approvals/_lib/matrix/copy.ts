/**
 * Approvals › Grid's words for its list of agents and its doors, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. The grid
 * and its why-drawer keep their English words for now. A mode's name comes
 * from THE list (`AGENT_WRITE_MODE_CHOICES`, @synap-core/types/agents), its
 * sentence from the pod (`agentUsers.governance` `line`). DRAFT French ("vous"), awaiting the
 * founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "podDefault.on":
    "Pod default: agents act directly on what can be undone, each change with Undo.",
  "podDefault.off": "Pod default: agents ask before every change.",
  "podDefault.change": "Change in Settings",
  "podDefault.failed": "Couldn’t read the pod default.",
  failed: "Couldn’t load the agents and their work.",
  retry: "Retry",
  "row.paused": "Paused",
  "row.writesFailed": "Couldn’t read how its writes land.",
  "row.writesHidden": "Only its owner or a pod admin can see this.",
  "row.computerDecides": "Set by its computer, {computer}",
  "row.change": "Change",
  "row.change.aria": "Change how {name}’s writes land",
  "row.why": "Why, per space",
  "row.why.aria": "What {name} may do in each space, and why",
  showAll: "Show all {count} agents",
  "agent.missing": "This agent is not in the grid",
  "agent.missingHint":
    "It was removed, or the pod has more agents than the grid holds.",
  "agent.page": "Its page",
} as const;

export const fr: Catalog<typeof en> = {
  "podDefault.on":
    "Par défaut : les agents agissent directement sur ce qui peut être annulé, chaque modification avec Annuler.",
  "podDefault.off":
    "Par défaut : les agents demandent avant chaque modification.",
  "podDefault.change": "Changer dans Réglages",
  "podDefault.failed": "Impossible de lire le réglage par défaut du pod.",
  failed: "Impossible de charger les agents et leur travail.",
  retry: "Réessayer",
  "row.paused": "En pause",
  "row.writesFailed": "Impossible de lire comment s’appliquent ses écritures.",
  "row.writesHidden":
    "Seul son propriétaire ou un administrateur du pod peut voir ceci.",
  "row.computerDecides": "Réglé par son ordinateur, {computer}",
  "row.change": "Changer",
  "row.change.aria": "Changer comment s’appliquent les écritures de {name}",
  "row.why": "Pourquoi, par espace",
  "row.why.aria": "Ce que {name} peut faire dans chaque espace, et pourquoi",
  showAll: "Afficher les {count} agents",
  "agent.missing": "Cet agent n’est pas dans la grille",
  "agent.missingHint":
    "Il a été retiré, ou le pod compte plus d’agents que la grille n’en contient.",
  "agent.page": "Sa page",
};

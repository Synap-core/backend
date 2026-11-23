/**
 * Approvals › Grid's words for its list of agents and its doors, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. The grid
 * and its why-drawer keep their English words for now. A mode's name comes
 * from THE list (`AGENT_WRITE_MODE_CHOICES`, @synap-core/types/agents), its
 * sentence from the pod (`agentUsers.governance` `line`). DRAFT French ("vous"), awaiting the
 * founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

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
  "grid.aria":
    "Agents and work",
  "grid.agent":
    "Agent",
  "grid.locked":
    "Locked",
  "partial":
    "Part of the pod is left out: {agents} agents and {columns} columns past the limit of {maxAgents} agents × {maxColumns} columns.",
  "showAllTypes":
    "Show all {n} agent types",
  "legend.aria":
    "Marks",
  "legend.platform":
    "Platform limit",
  "none.title":
    "No agents yet",
  "none.body":
    "Connect one from a computer. Each agent it sets up shows here with what it may do in every space.",
  "none.command":
    "synap init",
  "noProcesses.title":
    "No processes yet",
  "noProcesses.body":
    "A process is a playbook that works a kind's lifecycle; each gets its own column here. Until then, Other work shows what each agent may do in each space.",
  "noProcesses.browse":
    "Browse templates",
  "why.paused":
    "Paused — it takes no work until someone resumes it.",
  "why.floors":
    "Platform limits. No rule can widen them.",
  "why.decidedBy":
    "Decided by: {rung}",
  "why.computerAsks":
    "Its computer asks first here too.",
  "why.openApproval":
    "Open approval",
  "why.takeBack":
    "Take back",
  "why.heldBy":
    "An agent never does more than the computer it runs on, so a rule for this agent alone would change nothing here.",
  "why.openComputer":
    "Open its computer",
  "why.takeBack.title":
    "Take back this approval?",
  "why.showAll":
    "Show all {n}",
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
  "grid.aria":
    "Agents et travail",
  "grid.agent":
    "Agent",
  "grid.locked":
    "Verrouillé",
  "partial":
    "Une partie du pod est laissée de côté : {agents} agents et {columns} colonnes au-delà de la limite de {maxAgents} agents × {maxColumns} colonnes.",
  "showAllTypes":
    "Voir les {n} types d’agents",
  "legend.aria":
    "Repères",
  "legend.platform":
    "Limite de la plateforme",
  "none.title":
    "Aucun agent pour l’instant",
  "none.body":
    "Connectez-en un depuis un ordinateur. Chaque agent qu’il configure apparaît ici avec ce qu’il peut faire dans chaque espace.",
  "none.command":
    "synap init",
  "noProcesses.title":
    "Aucun processus pour l’instant",
  "noProcesses.body":
    "Un processus est un playbook qui fait vivre le cycle d’un type ; chacun a sa propre colonne ici. D’ici là, « Autre travail » montre ce que chaque agent peut faire dans chaque espace.",
  "noProcesses.browse":
    "Parcourir les modèles",
  "why.paused":
    "En pause — il ne prend aucun travail tant que quelqu’un ne le relance pas.",
  "why.floors":
    "Limites de la plateforme. Aucune règle ne peut les élargir.",
  "why.decidedBy":
    "Décidé par : {rung}",
  "why.computerAsks":
    "Son ordinateur demande aussi d’abord ici.",
  "why.openApproval":
    "Ouvrir l’approbation",
  "why.takeBack":
    "Reprendre",
  "why.heldBy":
    "Un agent ne fait jamais plus que l’ordinateur sur lequel il tourne : une règle pour cet agent seul ne changerait rien ici.",
  "why.openComputer":
    "Ouvrir son ordinateur",
  "why.takeBack.title":
    "Reprendre cette approbation ?",
  "why.showAll":
    "Voir les {n}",
};

/** The words' translator, in the ambient catalog locale. */
export function matrixT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

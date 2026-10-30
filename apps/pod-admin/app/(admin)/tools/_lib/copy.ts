/**
 * Tools' words — the one list (`/tools`) and the tool pages
 * (`/open/capability/:id`, `/open/skill/:id`) — as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. "Action"
 * means a capability's verb, and only that (decision 79f5b7a2). DRAFT French
 * ("vous"), awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  title: "Tools",
  description:
    "Everything this pod can do. Open a tool to see whether it is on, what is running and what it ran.",
  "search.placeholder": "Search tools…",
  "search.aria": "Search tools",
  "type.aria": "Type",
  "type.all": "All",
  "type.capabilities": "Capabilities",
  "type.instructions": "Instructions",
  "type.code": "Code",
  "chip.capability": "Capability",
  "chip.instruction": "Instructions",
  "chip.code": "Code",
  "view.aria": "View",
  "view.list": "List",
  "view.gallery": "Gallery",
  "empty.none": "Nothing is installed yet.",
  "empty.browse": "Browse the Marketplace",
  "empty.type": "No tool of this type yet.",
  "empty.search": "No tool matches “{query}”.",
  "failed.capabilities": "Couldn’t load the capabilities.",
  "failed.skills": "Couldn’t load the instructions and code.",
  "failed.catalog":
    "Couldn’t read which actions are on: the marks below may be incomplete.",
  "skills.capped":
    "Showing the first {n} instructions and code. Search to narrow.",
  "where.pod": "Whole pod",
  "where.you": "Only you",
  "where.space": "A space",
  "row.actionsOn": "{on} of {total} actions on",
  "row.lastRan": "last ran {when}",
  "card.noDescription": "No description.",
  "status.on": "On",
  "status.off": "Off",
  "status.someOff": "Some actions off",
  "status.actionsOff": "Actions off",
  "status.needsAccount": "Needs an account",
  "status.notOffered": "Not offered",
  "status.notInstalled": "Not installed",
  "status.unknown": "State unknown",
  "status.failedRuns": "{n, plural, one {# failed run} other {# failed runs}}",
  "status.stuckRuns": "{n, plural, one {# stuck run} other {# stuck runs}}",
  "running.title": "Running now",
  "running.failed": "Couldn’t check what is running.",
  "running.started": "Started {when}",
  "history.title": "History",
  "history.empty": "It hasn’t run yet.",
  "history.failed": "Couldn’t load its runs.",
  "history.showAll": "Show all its runs",
  "runs.toolTitle": "One tool’s runs",
  "runs.toolHint": "Its actions’ runs, newest first",
  "runs.openTool": "Open the tool",
  "runs.everyRun": "Every run",
  "skill.loading": "Loading tool…",
  "skill.instructions": "Instructions",
  "skill.inDocument": "Its instructions are kept in a document.",
  "skill.readDocument": "Read its instructions",
  "skill.noBody": "It has no instructions yet.",
  "skill.silence":
    "Instructions don’t run: an agent reads them when they apply. The pod doesn’t record when they are read, so there is no history to show.",
  "skill.readAndTurnOn": "Read and turn on",
  "skill.turnOnInApp": "Turn on in the app",
  "skill.turnOnConsequence":
    "From now on agents load these instructions when the skill applies. It runs nothing on its own.",
  "skill.notTurnedOn": "The pod didn’t turn it on.",
  "skill.turnOnTitle": "Turn on “{name}”?",
  "skill.openInApp": "Open in app",
  "fact.space": "Space",
  "fact.kind": "Kind",
  "fact.loadsBy": "Loads by",
  "fact.added": "Added",
  "id.tool": "Tool id",
  "id.space": "Space id",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Outils",
  description:
    "Tout ce que ce serveur sait faire. Ouvrez un outil pour voir s’il est activé, ce qui tourne et ce qu’il a fait.",
  "search.placeholder": "Rechercher un outil…",
  "search.aria": "Rechercher un outil",
  "type.aria": "Type",
  "type.all": "Tous",
  "type.capabilities": "Capacités",
  "type.instructions": "Instructions",
  "type.code": "Code",
  "chip.capability": "Capacité",
  "chip.instruction": "Instructions",
  "chip.code": "Code",
  "view.aria": "Affichage",
  "view.list": "Liste",
  "view.gallery": "Galerie",
  "empty.none": "Rien n’est encore installé.",
  "empty.browse": "Parcourir la Marketplace",
  "empty.type": "Aucun outil de ce type pour l’instant.",
  "empty.search": "Aucun outil ne correspond à « {query} ».",
  "failed.capabilities": "Impossible de charger les capacités.",
  "failed.skills": "Impossible de charger les instructions et le code.",
  "failed.catalog":
    "Impossible de lire quelles actions sont activées : les états ci-dessous peuvent être incomplets.",
  "skills.capped":
    "Affichage des {n} premières instructions et du code. Recherchez pour affiner.",
  "where.pod": "Tout le serveur",
  "where.you": "Vous seul",
  "where.space": "Un espace",
  "row.actionsOn": "{on} actions activées sur {total}",
  "row.lastRan": "dernière exécution {when}",
  "card.noDescription": "Pas de description.",
  "status.on": "Activé",
  "status.off": "Désactivé",
  "status.someOff": "Actions en partie désactivées",
  "status.actionsOff": "Actions désactivées",
  "status.needsAccount": "Compte à connecter",
  "status.notOffered": "Non proposé",
  "status.notInstalled": "Non installé",
  "status.unknown": "État inconnu",
  "status.failedRuns":
    "{n, plural, one {# exécution échouée} other {# exécutions échouées}}",
  "status.stuckRuns":
    "{n, plural, one {# exécution bloquée} other {# exécutions bloquées}}",
  "running.title": "En cours",
  "running.failed": "Impossible de vérifier ce qui tourne.",
  "running.started": "Démarré {when}",
  "history.title": "Historique",
  "history.empty": "Il n’a encore jamais tourné.",
  "history.failed": "Impossible de charger ses exécutions.",
  "history.showAll": "Voir toutes ses exécutions",
  "runs.toolTitle": "Les exécutions d’un outil",
  "runs.toolHint":
    "Les exécutions de ses actions, des plus récentes aux plus anciennes",
  "runs.openTool": "Ouvrir l’outil",
  "runs.everyRun": "Toutes les exécutions",
  "skill.loading": "Chargement de l’outil…",
  "skill.instructions": "Instructions",
  "skill.inDocument": "Ses instructions sont dans un document.",
  "skill.readDocument": "Lire ses instructions",
  "skill.noBody": "Il n’a pas encore d’instructions.",
  "skill.silence":
    "Des instructions ne tournent pas : un agent les lit quand elles s’appliquent. Le serveur n’enregistre pas ces lectures, il n’y a donc pas d’historique à afficher.",
  "skill.readAndTurnOn": "Lire et activer",
  "skill.turnOnInApp": "Activer dans l’application",
  "skill.turnOnConsequence":
    "Désormais, les agents chargent ces instructions quand la compétence s’applique. Elle n’exécute rien d’elle-même.",
  "skill.notTurnedOn": "Le serveur ne l’a pas activée.",
  "skill.turnOnTitle": "Activer « {name} » ?",
  "skill.openInApp": "Ouvrir dans l’application",
  "fact.space": "Espace",
  "fact.kind": "Type",
  "fact.loadsBy": "Chargée par",
  "fact.added": "Ajoutée",
  "id.tool": "Identifiant de l’outil",
  "id.space": "Identifiant de l’espace",
};

export const TOOLS_CATALOGS = { en, fr };

/** Tools' translator in the ambient catalog locale, for the pure models. */
export function toolsT() {
  return createT(ambientCatalogLocale(), TOOLS_CATALOGS);
}

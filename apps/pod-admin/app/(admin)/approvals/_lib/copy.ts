/**
 * The Approvals page's words, as catalogs (`@synap-core/types/i18n`): English
 * is the source and the type. The page's title is the vocabulary's
 * (`APPROVALS_TITLE`, the `governance_rule` kind), never written here. Who,
 * what and where a row names come from `@synap-core/types/governance-rules`,
 * its verdict from `resolveActionRunModeLabel`. DRAFT French ("vous"),
 * awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  description:
    "Which AI work runs on its own, which asks you first, and which never runs. Each line says where it came from and can be taken back.",
  "view.label": "View",
  "view.list": "List",
  "view.grid": "Grid",
  "filter.agent": "Agent",
  "filter.tool": "Tool",
  "filter.verdict": "Verdict",
  "filter.space": "Space",
  "filter.anyAgent": "Any agent",
  "filter.anyTool": "Any tool",
  "filter.anyVerdict": "Any verdict",
  "filter.anySpace": "Anywhere",
  "space.pod": "Whole pod",
  "space.unknown": "A space",
  "list.title": "Every approval",
  "list.failed": "Couldn’t load the approvals.",
  "list.empty":
    "No approvals yet. Answering “Always approve…” or “Never” on a request adds one here.",
  "list.emptyFiltered": "No approval matches these filters.",
  "list.more": "Show {count} more",
  "row.from": "From: {origin}",
  "origin.request": "A request you answered",
  "origin.playbook": "A playbook pre-approval",
  "origin.pod-default": "A pod default",
  "origin.posture": "The agent’s posture",
  "origin.computer": "Its computer, copied from an agent’s approval",
  "origin.tool-page": "The tool’s page",
  "origin.person": "Set by a person",
  "origin.pod": "Set up by the pod",
  "origin.unknown": "Not recorded",
  "takeBack.label": "Take back",
  "takeBack.aria": "Take back: {what}, for {who}",
  "takeBack.settings": "Change the switch",
  "takeBack.agent": "Change on its page",
  "takeBack.source": "Its approval",
  "takeBack.title": "Take back “{what}”?",
  "takeBack.auto":
    "From now on {who} asks you first before doing this. Nothing it already did is undone.",
  "takeBack.deny":
    "From now on {who} may ask you again to do this. Nothing is run without your answer.",
  "takeBack.propose":
    "This line stops applying. A broader approval, if one exists, decides instead.",
  "takeBack.done": "Taken back: {what}",
  "takeBack.failed": "Couldn’t take it back",
  "grid.agents": "Agents and how their writes land",
} as const;

export const fr: Catalog<typeof en> = {
  description:
    "Le travail d’IA qui s’exécute seul, celui qui vous demande d’abord, et celui qui ne s’exécute jamais. Chaque ligne dit d’où elle vient et peut être retirée.",
  "view.label": "Vue",
  "view.list": "Liste",
  "view.grid": "Grille",
  "filter.agent": "Agent",
  "filter.tool": "Outil",
  "filter.verdict": "Verdict",
  "filter.space": "Espace",
  "filter.anyAgent": "Tout agent",
  "filter.anyTool": "Tout outil",
  "filter.anyVerdict": "Tout verdict",
  "filter.anySpace": "Partout",
  "space.pod": "Tout le serveur",
  "space.unknown": "Un espace",
  "list.title": "Toutes les approbations",
  "list.failed": "Impossible de charger les approbations.",
  "list.empty":
    "Aucune approbation pour l’instant. Répondre « Toujours approuver… » ou « Jamais » sur une demande en ajoute une ici.",
  "list.emptyFiltered": "Aucune approbation ne correspond à ces filtres.",
  "list.more": "Afficher {count} de plus",
  "row.from": "Origine : {origin}",
  "origin.request": "Une demande à laquelle vous avez répondu",
  "origin.playbook": "Une pré-approbation de playbook",
  "origin.pod-default": "Un réglage par défaut du pod",
  "origin.posture": "La posture de l’agent",
  "origin.computer": "Son ordinateur, copié depuis l’approbation d’un agent",
  "origin.tool-page": "La page de l’outil",
  "origin.person": "Réglée par une personne",
  "origin.pod": "Mise en place par le pod",
  "origin.unknown": "Non enregistrée",
  "takeBack.label": "Retirer",
  "takeBack.aria": "Retirer : {what}, pour {who}",
  "takeBack.settings": "Changer le réglage",
  "takeBack.agent": "Changer sur sa page",
  "takeBack.source": "Son approbation",
  "takeBack.title": "Retirer « {what} » ?",
  "takeBack.auto":
    "Désormais {who} vous demande d’abord avant de le faire. Rien de ce qui a déjà été fait n’est annulé.",
  "takeBack.deny":
    "Désormais {who} peut vous redemander de le faire. Rien ne s’exécute sans votre réponse.",
  "takeBack.propose":
    "Cette ligne cesse de s’appliquer. Une approbation plus large, s’il en existe une, décide à sa place.",
  "takeBack.done": "Retirée : {what}",
  "takeBack.failed": "Impossible de la retirer",
  "grid.agents": "Les agents et la façon dont leurs écritures s’appliquent",
};

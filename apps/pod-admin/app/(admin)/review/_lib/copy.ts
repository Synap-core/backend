/**
 * Review's page words (its header, views, the layout offer and the list's
 * states), as catalogs (`@synap-core/types/i18n`): English is the source and
 * the type. Client words (audit 110dd4ab G1): requests ("Demandes"), never
 * proposals. The groups, rows, batch bar and drawer keep their English words
 * for now. DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  title: "Requests",
  description: "Everything waiting on your decision, in one place.",
  "list.showAll": "Show all {n}",
  "list.showFewer": "Show fewer",
  "view.waiting": "Waiting",
  "view.history": "History",
  groupBy: "Group by",
  settings: "Review settings",
  failed: "Couldn’t load what is waiting for you.",
  "empty.session": "Nothing from this job waits for you.",
  "empty.all": "Nothing is waiting on you.",
  "empty.filtered": "Nothing waiting here.",
  "layout.note":
    "Grouped by kind of decision. You can lay requests out another way.",
  "layout.choose": "Choose a layout",
  "layout.keep": "Keep this",
  "prefs.notSaved": "Your review settings weren’t saved",
  "always.done": "{name} may hand work to another AI without asking",
  "always.thisAgent": "This AI",
  "always.doneHint": "Take it back in Review settings.",
  "always.failed": "The rule wasn’t saved",
  // What each package asks of the person: the line under its name.
  "package.ask.questions": "an agent waits on your answer",
  "package.ask.access": "who may act or see · one at a time",
  "package.ask.releases": "go or no-go on a deploy",
  "package.ask.how-things-work":
    "rules and playbooks agents follow · read each",
  "package.ask.data-changes": "changes to your records",
  "package.ask.hand-offs": "work handed to an agent",
  "package.ask.knowledge":
    "what agents learned · skim, keep, reject the odd one",
  "package.ask.bookkeeping": "agents’ notes on their own sessions",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Demandes",
  description: "Tout ce qui attend votre décision, au même endroit.",
  "list.showAll": "Tout afficher ({n})",
  "list.showFewer": "Afficher moins",
  "view.waiting": "En attente",
  "view.history": "Historique",
  groupBy: "Regrouper par",
  settings: "Réglages des demandes",
  failed: "Impossible de charger ce qui vous attend.",
  "empty.session": "Rien de ce travail ne vous attend.",
  "empty.all": "Rien ne vous attend.",
  "empty.filtered": "Rien n’attend ici.",
  "layout.note":
    "Regroupées par type de décision. Vous pouvez présenter les demandes autrement.",
  "layout.choose": "Choisir une présentation",
  "layout.keep": "Garder ainsi",
  "prefs.notSaved": "Vos réglages des demandes n’ont pas été enregistrés",
  "always.done": "{name} peut confier du travail sans vous demander",
  "always.thisAgent": "Cette IA",
  "always.doneHint": "Vous pouvez le retirer dans les réglages des demandes.",
  "always.failed": "La règle n’a pas été enregistrée",
  "package.ask.questions": "un agent attend votre réponse",
  "package.ask.access": "qui peut agir ou voir · une par une",
  "package.ask.releases": "feu vert ou non pour un déploiement",
  "package.ask.how-things-work":
    "les règles et procédures que suivent les agents · à lire une par une",
  "package.ask.data-changes": "des changements dans vos fiches",
  "package.ask.hand-offs": "du travail confié à un agent",
  "package.ask.knowledge":
    "ce que les agents ont appris · parcourez, gardez, rejetez l’intrus",
  "package.ask.bookkeeping": "les notes des agents sur leurs propres sessions",
};

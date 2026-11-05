/**
 * The defaults step's words (`/start/defaults`), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type.
 * DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  title: "Your pod’s defaults",
  lead: "These are on or off already. Change any now, or later in pod admin.",
  "presence.label": "Approvals need you in person",
  "presence.line":
    "Sensitive approvals and changes ask for your passkey or Face ID. Turning it off asks for one too.",
  "reversible.label": "AIs act directly on what can be undone",
  "reversible.line":
    "They create, edit and link without asking, each change with Undo.",
  "ownOrganise.label": "AIs tidy their own new work",
  "ownOrganise.line":
    "They file what they just made into the project you named and close their own tasks, each with Undo.",
  "proactive.label": "AI reaches out on its own",
  "proactive.line":
    "A morning brief and nudges about your work, without you asking first.",
  "library.label": "Keep your Library alive",
  "library.line":
    "Each week, a suggestion to group what you saved, and old items brought back.",
  on: "On",
  off: "Off",
  "locked.operator": "Your pod’s operator turned this on. It stays on.",
  "locked.admin": "Only a pod admin can change this.",
  failed: "Couldn’t read this setting.",
  retry: "Try again",
  notChanged: "Couldn’t change this setting",
  notChangedHint: "Nothing changed. Try again.",
  continue: "Continue",
  back: "Back",
  recordFailed: "Couldn’t save this step. Try again.",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Les réglages par défaut de votre pod",
  lead: "Ils sont déjà activés ou désactivés. Modifiez-en maintenant, ou plus tard dans l’administration du pod.",
  "presence.label": "Les approbations demandent votre présence",
  "presence.line":
    "Les approbations et modifications sensibles demandent votre clé d’accès ou Face ID. Le désactiver en demande une aussi.",
  "reversible.label": "Les IA agissent directement sur ce qui peut être annulé",
  "reversible.line":
    "Elles créent, modifient et relient sans demander, chaque modification avec Annuler.",
  "ownOrganise.label": "Les IA rangent leur propre travail récent",
  "ownOrganise.line":
    "Elles classent ce qu’elles viennent de créer dans le projet que vous avez indiqué et ferment leurs propres tâches, chaque fois avec Annuler.",
  "proactive.label": "L’IA vous sollicite d’elle-même",
  "proactive.line":
    "Un point du matin et des rappels sur votre travail, sans que vous le demandiez.",
  "library.label": "Garder votre bibliothèque vivante",
  "library.line":
    "Chaque semaine, une suggestion pour regrouper ce que vous avez enregistré, et d’anciens éléments remis en avant.",
  on: "Activé",
  off: "Désactivé",
  "locked.operator": "L’opérateur de votre pod l’a activé. Il reste activé.",
  "locked.admin": "Seul un administrateur du pod peut modifier ce réglage.",
  failed: "Impossible de lire ce réglage.",
  retry: "Réessayer",
  notChanged: "Impossible de modifier ce réglage",
  notChangedHint: "Rien n’a changé. Réessayez.",
  continue: "Continuer",
  back: "Retour",
  recordFailed: "Impossible d’enregistrer cette étape. Réessayez.",
};

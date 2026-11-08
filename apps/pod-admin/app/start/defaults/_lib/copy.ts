/**
 * The defaults step's words (`/start/defaults`), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. The
 * presence row's name, what is sensitive and where to approve are the shared
 * presence words (`PRESENCE_WORDS`), merged in, never written twice. Every
 * row says "AIs" (plural), one form. DRAFT French ("vous"), awaiting the
 * founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";
import { PRESENCE_WORDS } from "@synap-core/types/presence";

const stepEn = {
  title: "Your pod’s defaults",
  lead: "These are on or off already. Change any now, or later in pod admin.",
  "presence.line": "{sensitive} need you in person. {where}",
  "presence.factors.none": "No passkey yet",
  "presence.factors.add": "Add one",
  "presence.factors.failed": "Couldn’t check your passkeys.",
  "presence.factors.addSecond": "Add an authenticator app or recovery codes",
  "reversible.label": "AIs act directly on what can be undone",
  "reversible.line":
    "They create, edit and link without asking, each change with Undo.",
  "ownOrganise.label": "AIs tidy their own new work",
  "ownOrganise.line":
    "They file what they just made into the project you named and close their own tasks, each with Undo.",
  "proactive.label": "AIs reach out on their own",
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
  notChanged: "Couldn’t change this setting.",
  notChangedHint: "Nothing changed.",
  continue: "Continue",
  back: "Back",
  recordFailed: "Couldn’t save this step. Try again.",
} as const;

const stepFr: Catalog<typeof stepEn> = {
  title: "Les réglages par défaut de votre pod",
  lead: "Ils sont déjà activés ou désactivés. Modifiez-en maintenant, ou plus tard dans l’administration du pod.",
  "presence.line": "{sensitive} demandent votre présence. {where}",
  "presence.factors.none": "Pas encore de clé d’accès",
  "presence.factors.add": "En ajouter une",
  "presence.factors.failed": "Impossible de vérifier vos clés d’accès.",
  "presence.factors.addSecond":
    "Ajouter une app d’authentification ou des codes de récupération",
  "reversible.label": "Les IA agissent directement sur ce qui peut être annulé",
  "reversible.line":
    "Elles créent, modifient et relient sans demander, chaque modification avec Annuler.",
  "ownOrganise.label": "Les IA rangent leur propre travail récent",
  "ownOrganise.line":
    "Elles classent ce qu’elles viennent de créer dans le projet que vous avez indiqué et ferment leurs propres tâches, chaque fois avec Annuler.",
  "proactive.label": "Les IA vous sollicitent d’elles-mêmes",
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
  notChanged: "Impossible de modifier ce réglage.",
  notChangedHint: "Rien n’a changé.",
  continue: "Continuer",
  back: "Retour",
  recordFailed: "Impossible d’enregistrer cette étape. Réessayez.",
};

export const en = { ...PRESENCE_WORDS.en, ...stepEn };
export const fr: Catalog<typeof en> = { ...PRESENCE_WORDS.fr, ...stepFr };

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
};

/** The object views' translator, in the ambient catalog locale. */
export function objectViewsT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

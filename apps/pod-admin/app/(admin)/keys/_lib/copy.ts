/**
 * The words of "change what a key may do" (the Keys drawer's door and the
 * editor it opens), as catalogs (`@synap-core/types/i18n`): English is the
 * source and the type. DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "edit.open": "Change what it may do",
  "edit.title": "Change what {name} may do",
  "edit.intro":
    "Tick what it may read, create, change or delete, and where. Nothing is saved until you confirm.",
  "edit.grant": "Access {n}",
  "edit.unchanged": "Nothing has changed yet.",
  "edit.added": "Adds: {list}.",
  "edit.removed": "Takes away: {list}.",
  "edit.place": "Changes where it may act.",
  "edit.widens": "This gives the key more than it has now.",
  "edit.more": "{list} and {n} more",
  "edit.empty":
    "A key keeps at least one permission. To stop it altogether, revoke it.",
  "edit.cancel": "Cancel",
  "edit.save": "Save changes",
  "edit.retry": "Try again",
  "edit.saved": "Saved. {name} now has the access you chose.",
  "edit.failed": "Couldn’t change what this key may do",
  "edit.loadFailed": "Couldn’t load this key’s access.",
  "edit.placesFailed": "Couldn’t load the spaces and projects to pick from.",
  "edit.loading": "Loading its access",
  "edit.app":
    "This key belongs to an app. Change its access on the app’s page.",
  "edit.appOpen": "Open the app",
  "edit.notYours":
    "Only the person this key belongs to can change what it may do.",
  "edit.whoFailed": "Couldn’t check whether you may change this key.",
  "edit.agentKeys": "Open its keys",
} as const;

export const fr: Catalog<typeof en> = {
  "edit.open": "Modifier ce qu’elle peut faire",
  "edit.title": "Modifier ce que peut faire {name}",
  "edit.intro":
    "Cochez ce qu’elle peut lire, créer, modifier ou supprimer, et où. Rien n’est enregistré tant que vous ne confirmez pas.",
  "edit.grant": "Accès {n}",
  "edit.unchanged": "Rien n’a encore changé.",
  "edit.added": "Ajoute : {list}.",
  "edit.removed": "Retire : {list}.",
  "edit.place": "Change l’endroit où elle peut agir.",
  "edit.widens": "Cette clé aura plus de droits qu’aujourd’hui.",
  "edit.more": "{list} et {n} autres",
  "edit.empty":
    "Une clé garde au moins une permission. Pour l’arrêter complètement, révoquez-la.",
  "edit.cancel": "Annuler",
  "edit.save": "Enregistrer les changements",
  "edit.retry": "Réessayer",
  "edit.saved": "Enregistré. {name} a maintenant l’accès que vous avez choisi.",
  "edit.failed": "Impossible de modifier ce que cette clé peut faire",
  "edit.loadFailed": "Impossible de charger l’accès de cette clé.",
  "edit.placesFailed":
    "Impossible de charger les espaces et projets à choisir.",
  "edit.loading": "Chargement de son accès",
  "edit.app":
    "Cette clé appartient à une application. Modifiez son accès sur la page de l’application.",
  "edit.appOpen": "Ouvrir l’application",
  "edit.notYours":
    "Seule la personne à qui appartient cette clé peut modifier ce qu’elle peut faire.",
  "edit.whoFailed": "Impossible de vérifier si vous pouvez modifier cette clé.",
  "edit.agentKeys": "Ouvrir ses clés",
};

export const KEYS_CATALOGS = { en, fr };

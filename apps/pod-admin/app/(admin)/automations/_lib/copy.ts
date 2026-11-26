/**
 * The automations list and a pod rule's page, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French ("vous"), awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "exit.create": "Create in app",
  "filter.show": "Show",
  "callout.review": "Review never-ran automations",
  loadFailed: "Couldn't load automations.",
  showMore: "Show {n} more",
  podRulesFailed:
    "The pod’s own automations couldn’t be loaded, so they are missing from this list.",
  tryAgain: "Try again",
  healthFailed:
    "Run health couldn’t be loaded, so “Failing” may be missing automations.",
  healthCapped: "Run health covers the 2,000 most recently run automations.",
  reading: "Reading run health",
  "confirm.run.body":
    "It runs its whole flow once, as if its trigger had happened — including anything it sends or changes. If the pod needs someone to approve it, it is proposed instead and waits in Review.",
  "confirm.podTurnOn.body":
    "From now on the pod applies it, for everyone in this pod, each time its trigger happens. You can pause it here at any time.",
  "confirm.turnOn.body":
    "From now on it runs on its own each time its trigger happens, including anything it sends or changes. You can pause it here at any time.",
  "confirm.pause.body":
    "It won’t start new runs until someone turns it back on. Nothing it already did is undone.",
  "rows.runs": "{n, plural, one {# run} other {# runs}}",
  "rows.runsFailed": "{runs} · {failed} failed",
  "rows.neverRan":
    "{n, plural, one {# automation has never run.} other {# automations have never run.}}",
  "obj.title": "Automation",
  "obj.readFailed": "This automation couldn’t be read.",
  "obj.missing": "No automation by this name, or you can’t see it.",
  "obj.back": "Back to the automations",
  "obj.crumb": "Automations",
  "obj.on": "On",
  "obj.paused": "Paused",
  "obj.what": "What it does",
  "obj.when": "When",
  "obj.then": "Then",
  "obj.lately": "What it did lately",
  "obj.latelyHint": "Its last moves that touched your things, newest first.",
  "obj.openProposal": "Open the proposal",
  "obj.about": "About it",
  "obj.owner": "Owner",
  "obj.doneOrLost": "Done or lost",
  "obj.moves": "Its moves",
  "obj.turnOn.body":
    "From now on the pod applies it, for everyone in this pod, each time its trigger happens.",
} as const;

export const fr: Catalog<typeof en> = {
  "exit.create": "Créer dans l’app",
  "filter.show": "Afficher",
  "callout.review": "Examiner les automatisations jamais exécutées",
  loadFailed: "Impossible de charger les automatisations.",
  showMore: "Voir {n} de plus",
  podRulesFailed:
    "Les automatisations propres au pod n’ont pas pu être chargées : elles manquent dans cette liste.",
  tryAgain: "Réessayer",
  healthFailed:
    "L’état des exécutions n’a pas pu être chargé : « En échec » peut manquer des automatisations.",
  healthCapped:
    "L’état des exécutions couvre les 2 000 automatisations exécutées le plus récemment.",
  reading: "Lecture de l’état des exécutions",
  "confirm.run.body":
    "Elle exécute tout son flux une fois, comme si son déclencheur s’était produit — y compris tout ce qu’elle envoie ou modifie. Si le pod a besoin d’une approbation, elle est proposée à la place et attend dans Demandes.",
  "confirm.podTurnOn.body":
    "Dès maintenant, le pod l’applique, pour tout le monde dans ce pod, à chaque fois que son déclencheur se produit. Vous pouvez la mettre en pause ici à tout moment.",
  "confirm.turnOn.body":
    "Dès maintenant, elle s’exécute seule à chaque fois que son déclencheur se produit, y compris tout ce qu’elle envoie ou modifie. Vous pouvez la mettre en pause ici à tout moment.",
  "confirm.pause.body":
    "Elle ne lancera plus de nouvelles exécutions tant que quelqu’un ne la rallume pas. Rien de ce qu’elle a déjà fait n’est annulé.",
  "rows.runs": "{n, plural, one {# exécution} other {# exécutions}}",
  "rows.runsFailed": "{runs} · {failed} en échec",
  "rows.neverRan":
    "{n, plural, one {# automatisation ne s’est jamais exécutée.} other {# automatisations ne se sont jamais exécutées.}}",
  "obj.title": "Automatisation",
  "obj.readFailed": "Cette automatisation n’a pas pu être lue.",
  "obj.missing":
    "Aucune automatisation de ce nom, ou vous ne pouvez pas la voir.",
  "obj.back": "Retour aux automatisations",
  "obj.crumb": "Automatisations",
  "obj.on": "Active",
  "obj.paused": "En pause",
  "obj.what": "Ce qu’elle fait",
  "obj.when": "Quand",
  "obj.then": "Alors",
  "obj.lately": "Ce qu’elle a fait récemment",
  "obj.latelyHint":
    "Ses derniers mouvements qui ont touché vos éléments, du plus récent au plus ancien.",
  "obj.openProposal": "Ouvrir la proposition",
  "obj.about": "À son sujet",
  "obj.owner": "Propriétaire",
  "obj.doneOrLost": "Terminé ou perdu",
  "obj.moves": "Ses mouvements",
  "obj.turnOn.body":
    "Dès maintenant, le pod l’applique, pour tout le monde dans ce pod, à chaque fois que son déclencheur se produit.",
};

/** The automations' translator, in the ambient catalog locale. */
export function automationsT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

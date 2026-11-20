/**
 * Approvals › Daily write limits, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French ("vous"), awaiting the
 * founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  title: "Daily write limits",
  description:
    "How many writes an agent may run on its own each day. Past the limit, its writes ask you first until midnight (UTC). With no limit, there is none.",
  back: "Approvals",
  add: "Add limit",
  "list.title": "Every limit",
  "list.failed": "Couldn’t load the daily write limits.",
  "list.empty":
    "No limit. Agents run as many writes on their own as their approvals allow.",
  "row.perDay": "{count, plural, one {# write a day} other {# writes a day}}",
  "who.any": "Every agent",
  "who.computers": "Every computer",
  "who.unnamed": "An agent",
  "where.pod": "Whole pod",
  "where.space": "A space",
  "row.untilMidnight": "until midnight (UTC)",
  "row.today": "{used} of {limit} today",
  "row.reached": "Reached today",
  "row.otherInForce": "Another limit applies: {limit} a day",
  "row.usageFailed": "Today’s use couldn’t be read",
  "takeBack.label": "Take back",
  "takeBack.aria": "Take back the limit for {who}",
  "takeBack.title": "Take back this limit?",
  "takeBack.consequence":
    "From now on {who} is no longer held to {limit} writes a day here. A broader limit, if one exists, applies instead.",
  "takeBack.done": "Limit taken back",
  "takeBack.failed": "Couldn’t take it back",
  "form.title": "Add a daily write limit",
  "form.submit": "Add limit",
  "form.who": "Applies to",
  "form.whoAny": "Every agent",
  "form.whoAgent": "One agent",
  "form.agent": "Agent",
  "form.agentsFailed": "Couldn’t load the agents.",
  "form.where": "Where",
  "form.wherePod": "Whole pod",
  "form.whereSpace": "One space",
  "form.space": "Space",
  "form.value": "Writes per day",
  "form.valueHint": "A whole number from 1.",
  "form.done":
    "Limit added: {count, plural, one {# write a day} other {# writes a day}}",
  "form.failed": "Couldn’t add the limit",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Limites d’écritures par jour",
  description:
    "Combien d’écritures un agent peut exécuter seul chaque jour. Au-delà, ses écritures vous demandent d’abord jusqu’à minuit (UTC). Sans limite, il n’y en a aucune.",
  back: "Approbations",
  add: "Ajouter une limite",
  "list.title": "Toutes les limites",
  "list.failed": "Impossible de charger les limites d’écritures par jour.",
  "list.empty":
    "Aucune limite. Les agents exécutent seuls autant d’écritures que leurs approbations le permettent.",
  "row.perDay":
    "{count, plural, one {# écriture par jour} other {# écritures par jour}}",
  "who.any": "Tous les agents",
  "who.computers": "Tous les ordinateurs",
  "who.unnamed": "Un agent",
  "where.pod": "Tout le serveur",
  "where.space": "Un espace",
  "row.untilMidnight": "jusqu’à minuit (UTC)",
  "row.today": "{used} sur {limit} aujourd’hui",
  "row.reached": "Atteinte aujourd’hui",
  "row.otherInForce": "Une autre limite s’applique : {limit} par jour",
  "row.usageFailed": "Impossible de lire l’usage du jour",
  "takeBack.label": "Retirer",
  "takeBack.aria": "Retirer la limite de {who}",
  "takeBack.title": "Retirer cette limite ?",
  "takeBack.consequence":
    "Désormais {who} n’est plus tenu à {limit} écritures par jour ici. Une limite plus large, s’il en existe une, s’applique à la place.",
  "takeBack.done": "Limite retirée",
  "takeBack.failed": "Impossible de la retirer",
  "form.title": "Ajouter une limite d’écritures par jour",
  "form.submit": "Ajouter la limite",
  "form.who": "S’applique à",
  "form.whoAny": "Tous les agents",
  "form.whoAgent": "Un agent",
  "form.agent": "Agent",
  "form.agentsFailed": "Impossible de charger les agents.",
  "form.where": "Où",
  "form.wherePod": "Tout le serveur",
  "form.whereSpace": "Un espace",
  "form.space": "Espace",
  "form.value": "Écritures par jour",
  "form.valueHint": "Un nombre entier à partir de 1.",
  "form.done":
    "Limite ajoutée : {count, plural, one {# écriture par jour} other {# écritures par jour}}",
  "form.failed": "Impossible d’ajouter la limite",
};

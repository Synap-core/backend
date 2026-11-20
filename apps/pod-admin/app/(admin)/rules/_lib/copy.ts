/**
 * The Rules page's words, as catalogs (`@synap-core/types/i18n`): English is
 * the source and the type. The title is the vocabulary's plural of `rule`,
 * never written here. DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  description:
    "The guidelines every agent is held to in their scope: always or never. An agent cannot skip one. Know-how it loads when needed is a skill, under Tools.",
  "filter.where": "Where",
  "filter.anywhere": "Anywhere",
  "where.pod": "Whole pod",
  "where.user": "Only one person",
  "where.space": "A space",
  "list.title": "Every rule",
  "list.failed": "Couldn’t load the rules.",
  "list.empty":
    "No rules yet. A rule is written in the Synap app or by an agent you ask: “always…” or “never…”.",
  "list.none": "No rule matches “{query}”.",
  "list.noneHere": "No rule applies here.",
  "list.partial":
    "Only the first {count} skills were read, so some rules may be missing.",
  "automation.one": "An automation",
  "automation.many": "{count} automations",
  "automation.failed": "Couldn’t read which rules came with an automation.",
  search: "Search rules",
  retry: "Try again",
} as const;

export const fr: Catalog<typeof en> = {
  description:
    "Les consignes auxquelles chaque agent est tenu dans leur portée : toujours ou jamais. Un agent ne peut pas en sauter une. Un savoir-faire qu’il charge au besoin est une compétence, dans Outils.",
  "filter.where": "Où",
  "filter.anywhere": "Partout",
  "where.pod": "Tout le serveur",
  "where.user": "Une seule personne",
  "where.space": "Un espace",
  "list.title": "Toutes les règles",
  "list.failed": "Impossible de charger les règles.",
  "list.empty":
    "Aucune règle pour l’instant. Une règle s’écrit dans l’app Synap ou par un agent à qui vous la demandez : « toujours… » ou « jamais… ».",
  "list.none": "Aucune règle ne correspond à « {query} ».",
  "list.noneHere": "Aucune règle ne s’applique ici.",
  "list.partial":
    "Seules les {count} premières compétences ont été lues : des règles peuvent manquer.",
  "automation.one": "Une automatisation",
  "automation.many": "{count} automatisations",
  "automation.failed":
    "Impossible de lire quelles règles viennent avec une automatisation.",
  search: "Rechercher des règles",
  retry: "Réessayer",
};

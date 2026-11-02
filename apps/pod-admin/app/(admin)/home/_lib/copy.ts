/**
 * Home's words, as catalogs (`@synap-core/types/i18n`): English is the
 * source and the type. Client words (audit 110dd4ab G1): requests, never
 * proposals. The rows of the "Needs you" band are the health checks' own
 * sentences (`needs-you.ts`) and stay English for now; "Pod at a glance" is
 * the operator's (behind "All tools"). DRAFT French ("vous"), awaiting the
 * founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  title: "Home",
  "description.admin":
    "What your AIs did, what waits for you, and how it runs.",
  "description.member": "What your AIs did and what waits for you.",
  "brief.title": "Morning brief",
  "brief.hint": "From your AIs, {when}",
  "brief.empty":
    "No brief yet. Each morning, a few lines on what was done and what waits for you arrive here.",
  "brief.failed": "Couldn’t load the morning brief.",
  "brief.history": "See what was decided",
  "requests.title": "Requests waiting",
  "requests.hint": "The newest requests waiting for you",
  "requests.seeAll":
    "{n, plural, one {See the request} other {See all # requests}}",
  "requests.seeAllFloor": "See all {n}+ requests",
  "requests.open": "Open requests",
  "requests.empty": "Nothing waits for you.",
  "requests.failed": "Couldn’t load the requests.",
  "needsYou.title": "Needs you",
  "needsYou.hint": "Most urgent first",
  "needsYou.none": "Nothing needs you.",
  "needsYou.more": "+{n} more, less urgent",
  "needsYou.passing":
    "{n, plural, one {# check passing} other {# checks passing}}",
  "health.unknown": "The service status is unknown right now.",
  "health.checked": "Checked {when}",
  "health.checkAgain": "Check again",
  "failed.health": "Couldn’t run the health checks.",
  "failed.sync": "Couldn’t load the sync status.",
  "failed.updates": "Couldn’t read the update status.",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Accueil",
  "description.admin":
    "Ce que vos IA ont fait, ce qui vous attend, et l’état du service.",
  "description.member": "Ce que vos IA ont fait et ce qui vous attend.",
  "brief.title": "Le point du matin",
  "brief.hint": "De vos IA, {when}",
  "brief.empty":
    "Pas encore de point. Chaque matin, quelques lignes sur ce qui a été fait et ce qui vous attend arrivent ici.",
  "brief.failed": "Impossible de charger le point du matin.",
  "brief.history": "Voir ce qui a été décidé",
  "requests.title": "Demandes en attente",
  "requests.hint": "Les dernières demandes qui vous attendent",
  "requests.seeAll":
    "{n, plural, one {Voir la demande} other {Voir les # demandes}}",
  "requests.seeAllFloor": "Voir les {n}+ demandes",
  "requests.open": "Ouvrir les demandes",
  "requests.empty": "Rien ne vous attend.",
  "requests.failed": "Impossible de charger les demandes.",
  "needsYou.title": "À traiter",
  "needsYou.hint": "Le plus urgent d’abord",
  "needsYou.none": "Rien ne demande votre attention.",
  "needsYou.more":
    "{n, plural, one {+# autre, moins urgent} other {+# autres, moins urgents}}",
  "needsYou.passing":
    "{n, plural, one {# vérification réussie} other {# vérifications réussies}}",
  "health.unknown": "L’état du service est inconnu pour le moment.",
  "health.checked": "Vérifié {when}",
  "health.checkAgain": "Vérifier à nouveau",
  "failed.health": "Impossible de lancer les vérifications.",
  "failed.sync": "Impossible de charger l’état de la synchronisation.",
  "failed.updates": "Impossible de lire l’état des mises à jour.",
};

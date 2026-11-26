/**
 * Home's words, as catalogs (`@synap-core/types/i18n`): English is the
 * source and the type. Client words (audit 110dd4ab G1): requests, never
 * proposals. The rows of the "Needs you" band are the health checks' own
 * sentences (`needs-you.ts`) and stay English for now; "Pod at a glance" is
 * the operator's (behind "All tools"). DRAFT French ("vous"), awaiting the
 * founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

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
  "requests.hint": "Approve or refuse what agents want to change.",
  "requests.seeAll":
    "{n, plural, one {See the request} other {See all # requests}}",
  "requests.seeAllFloor": "See all {n}+ requests",
  "requests.open": "Open requests",
  "requests.work": "Open Work in the desktop app",
  "requests.empty": "Nothing waits for you.",
  "requests.failed": "Couldn’t count the requests.",
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
  "band.title": "Getting started",
  "band.saved":
    "Your setup is saved at step {n} of {of}. The next steps are not in the console yet.",
  "band.change": "Change what Synap runs first",
  "band.failed": "Couldn't load your setup progress.",
  offline: "You’re offline. This shows again when you’re back online.",
  "access.title": "My access",
  "access.hint": "The spaces you are in, your computers and your keys",
  "access.spaces.empty":
    "You’re not in any space yet. A pod admin adds you to one.",
  "access.spaces.failed": "Couldn’t load your spaces.",
  "access.spaces.showAll": "Show all {n} spaces",
  "access.computers": "Computers",
  "access.computers.count":
    "{n, plural, =0 {None connected yet} one {# connected} other {# connected}}",
  "access.computers.failed": "Couldn’t load your computers.",
  "access.keys": "Keys",
  "access.keys.count":
    "{n, plural, =0 {No key in use} one {# key in use} other {# keys in use}}",
  "access.keys.failed": "Couldn’t load your keys.",
  "artifacts.title": "Made for you",
  "artifacts.hint": "What your AIs made for you, newest first",
  "artifacts.empty":
    "Nothing made for you recently. When one of your AIs makes something for you, it shows here.",
  "artifacts.failed": "Couldn’t load what your AIs made for you.",
  "artifacts.showAll": "Show all {n}",
  "receipts.title": "Done for you",
  "receipts.hint": "What AIs did in your spaces, and who decided it",
  "receipts.empty":
    "Nothing yet. What AIs do in your spaces is listed here once it is decided.",
  "receipts.failed": "Couldn’t load what your AIs did.",
  "receipts.all": "See all in History",
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
  "requests.hint": "Acceptez ou refusez ce que les agents veulent changer.",
  "requests.seeAll":
    "{n, plural, one {Voir la demande} other {Voir les # demandes}}",
  "requests.seeAllFloor": "Voir les {n}+ demandes",
  "requests.open": "Ouvrir les demandes",
  "requests.work": "Ouvrir Work dans l’app de bureau",
  "requests.empty": "Rien ne vous attend.",
  "requests.failed": "Impossible de compter les demandes.",
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
  "band.title": "Pour démarrer",
  "band.saved":
    "Votre configuration est enregistrée à l’étape {n} sur {of}. Les étapes suivantes ne sont pas encore dans la console.",
  "band.change": "Changer ce que Synap lance en premier",
  "band.failed": "Impossible de charger l’avancement de votre configuration.",
  offline:
    "Vous êtes hors ligne. Ceci réapparaîtra une fois la connexion revenue.",
  "access.title": "Mes accès",
  "access.hint": "Vos espaces, vos ordinateurs et vos clés",
  "access.spaces.empty":
    "Vous n’êtes encore dans aucun espace. Un administrateur du pod vous y ajoute.",
  "access.spaces.failed": "Impossible de charger vos espaces.",
  "access.spaces.showAll": "Voir les {n} espaces",
  "access.computers": "Ordinateurs",
  "access.computers.count":
    "{n, plural, =0 {Aucun connecté pour l’instant} one {# connecté} other {# connectés}}",
  "access.computers.failed": "Impossible de charger vos ordinateurs.",
  "access.keys": "Clés",
  "access.keys.count":
    "{n, plural, =0 {Aucune clé en service} one {# clé en service} other {# clés en service}}",
  "access.keys.failed": "Impossible de charger vos clés.",
  "artifacts.title": "Fait pour vous",
  "artifacts.hint": "Ce que vos IA ont fait pour vous, le plus récent d’abord",
  "artifacts.empty":
    "Rien de fait pour vous récemment. Quand une de vos IA fait quelque chose pour vous, cela apparaît ici.",
  "artifacts.failed": "Impossible de charger ce que vos IA ont fait pour vous.",
  "artifacts.showAll": "Tout voir ({n})",
  "receipts.title": "Fait en votre nom",
  "receipts.hint": "Ce que les IA ont fait dans vos espaces, et qui l’a décidé",
  "receipts.empty":
    "Rien pour l’instant. Ce que les IA font dans vos espaces s’affiche ici une fois décidé.",
  "receipts.failed": "Impossible de charger ce que vos IA ont fait.",
  "receipts.all": "Tout voir dans l’Historique",
};

/** The words' translator, in the ambient catalog locale. */
export function homeT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

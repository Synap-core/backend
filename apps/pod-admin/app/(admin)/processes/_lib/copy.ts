/**
 * Words of the process pages (`/processes`, `/processes/[id]`, the
 * `/open/playbook/:id` card), as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French, awaiting the founder's
 * review. Only sentences and explanations live here (the pod admin
 * convention: `components/copy.ts` `listSearch.*`); a kind's noun, a status
 * or an action's label comes from the vocabulary door, never from here.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "list.description":
    "Each line of work: its steps, what it needs, and how its runs go.",
  "list.search": "Search processes",
  "list.filter.allSpaces": "All spaces",
  "list.filter.health": "Health",
  "list.filter.anyHealth": "Any health",
  "list.filter.attention": "Needs attention",
  "list.hint": "Archived processes are left out.",
  "list.empty":
    "No processes yet. A space template brings its processes, or make one in the Synap app.",
  "list.noMatch": "No process matches these filters.",
  "list.failed": "Couldn’t load processes.",
  "list.create": "Create in app",
  "list.steps": "{n, plural, one {# step} other {# steps}}",
  "list.allAutomations": "All automations",
  "list.outside":
    "{n, plural, one {# active automation runs outside any process.} other {# active automations run outside any process.}}",
  "list.outsideDoor": "See them",
  "list.outsideFailed": "The automations outside a process couldn’t be read.",
  "list.noSpace": "Not in a space",
  "list.aSpace": "A space",
  "list.spaceUnread": "Space couldn’t be read",
  "count.needsYou": "{n, plural, one {# needs you} other {# need you}}",
  "count.failedThisWeek": "{n} failed this week",
  "count.open": "{n} open",
  "count.doneThisWeek": "{n} done this week",
  "count.none": "Nothing open; no runs this week",
  "count.unmeasured": "Some counts couldn’t be read.",
  "count.reassure":
    "Runs are worked in the desktop app: each count opens them there.",
  "fact.installedFrom": "Installed from",
  "fact.version": "Version",
  "fact.runs": "Runs",
  "installed.local": "Made on this pod",
  "installed.package": "{name} · v{version}",
  "installed.packageOnly": "{name}",
  "action.reviewUpdate": "Review the update",
  "action.openInApp": "Open in app",
  "action.proposed": "Sent for review: it changes once someone approves it.",
  "action.failed": "That didn’t work",
  "block.checks": "Done when",
  "block.skills": "What agents load",
  "block.moves": "What it moves",
  "block.needs": "Needs",
  "block.unavailable": "This part couldn’t be read.",
  "when.manual": "A person can also start it by hand.",
  "when.workers":
    "{n, plural, one {# worker moves it along.} other {# workers move it along.}}",
  "steps.uses": "Uses",
  "checks.ofStep": "{statement} · at {step}",
  "moves.undeclared":
    "Some steps name a status the kind does not declare: {statuses}.",
  "needs.empty": "No provider yet",
  "needs.unknown": "Couldn’t check",
  "needs.chooseInApp": "Choose in app",
  "needs.readOnly":
    "A provider is chosen in the Synap app for now; this page shows who fills each need.",
  "needs.shared":
    "Shared with every process in this space that needs the same thing.",
  "access.title": "Who may run it",
  "access.none": "Your agents ask you before each run.",
  "access.unavailable": "Who may run it couldn’t be read.",
  "access.allowed":
    "Your agents may start it without asking at version {version}. A new version asks again.",
  "access.outdated":
    "Your agents were allowed version {allowed}; it has changed since, so they ask again.",
  "access.door": "What each agent may do",
  "archive.description":
    "When it is no longer a line of work anyone should start.",
  "archive.consequence":
    "It stops being offered and its schedule and starting rules stop firing. Runs already made, and what they produced, stay. If the pod needs someone to approve it, it is proposed instead and waits in Requests.",
  "archive.proposed": "Archiving was proposed for review.",
  "archive.failed": "Couldn’t archive the process",
  "ids.process": "Process id",
  "ids.space": "Space id",
  loading: "Loading process…",
} as const;

export const fr: Catalog<typeof en> = {
  "list.description":
    "Chaque ligne de travail : ses étapes, ce dont elle a besoin et comment se passent ses exécutions.",
  "list.search": "Rechercher un processus",
  "list.filter.allSpaces": "Tous les espaces",
  "list.filter.health": "État",
  "list.filter.anyHealth": "Tous les états",
  "list.filter.attention": "À regarder",
  "list.hint": "Les processus archivés sont exclus.",
  "list.empty":
    "Aucun processus pour l’instant. Un modèle d’espace apporte ses processus, ou créez-en un dans l’app Synap.",
  "list.noMatch": "Aucun processus ne correspond à ces filtres.",
  "list.failed": "Impossible de charger les processus.",
  "list.create": "Créer dans l’app",
  "list.steps": "{n, plural, one {# étape} other {# étapes}}",
  "list.allAutomations": "Toutes les automatisations",
  "list.outside":
    "{n, plural, one {# automatisation active tourne hors de tout processus.} other {# automatisations actives tournent hors de tout processus.}}",
  "list.outsideDoor": "Les voir",
  "list.outsideFailed":
    "Les automatisations hors processus n’ont pas pu être lues.",
  "list.noSpace": "Hors espace",
  "list.aSpace": "Un espace",
  "list.spaceUnread": "Espace illisible",
  "count.needsYou":
    "{n, plural, one {# attend votre réponse} other {# attendent votre réponse}}",
  "count.failedThisWeek": "{n} en échec cette semaine",
  "count.open": "{n} en cours",
  "count.doneThisWeek":
    "{n, plural, one {# terminée cette semaine} other {# terminées cette semaine}}",
  "count.none": "Rien en cours ; aucune exécution cette semaine",
  "count.unmeasured": "Certains comptes n’ont pas pu être lus.",
  "count.reassure":
    "Les exécutions se traitent dans l’app de bureau : chaque compte les y ouvre.",
  "fact.installedFrom": "Installé depuis",
  "fact.version": "Version",
  "fact.runs": "Exécutions",
  "installed.local": "Créé sur ce pod",
  "installed.package": "{name} · v{version}",
  "installed.packageOnly": "{name}",
  "action.reviewUpdate": "Examiner la mise à jour",
  "action.openInApp": "Ouvrir dans l’app",
  "action.proposed":
    "Envoyé pour validation : le changement s’applique une fois approuvé.",
  "action.failed": "Cela n’a pas fonctionné",
  "block.checks": "Terminé quand",
  "block.skills": "Ce que chargent les agents",
  "block.moves": "Ce qu’il fait avancer",
  "block.needs": "Besoins",
  "block.unavailable": "Cette partie n’a pas pu être lue.",
  "when.manual": "Une personne peut aussi le lancer à la main.",
  "when.workers":
    "{n, plural, one {# agent de suivi le fait avancer.} other {# agents de suivi le font avancer.}}",
  "steps.uses": "Utilise",
  "checks.ofStep": "{statement} · à l’étape {step}",
  "moves.undeclared":
    "Certaines étapes nomment un statut que le type ne déclare pas : {statuses}.",
  "needs.empty": "Pas encore de fournisseur",
  "needs.unknown": "Vérification impossible",
  "needs.chooseInApp": "Choisir dans l’app",
  "needs.readOnly":
    "Le fournisseur se choisit pour l’instant dans l’app Synap ; cette page montre qui remplit chaque besoin.",
  "needs.shared":
    "Partagé avec chaque processus de cet espace qui a le même besoin.",
  "access.title": "Qui peut le lancer",
  "access.none": "Vos agents vous demandent avant chaque exécution.",
  "access.unavailable": "Impossible de lire qui peut le lancer.",
  "access.allowed":
    "Vos agents peuvent le lancer sans demander en version {version}. Une nouvelle version redemande.",
  "access.outdated":
    "Vos agents étaient autorisés en version {allowed} ; il a changé depuis, ils redemandent donc.",
  "access.door": "Ce que chaque agent peut faire",
  "archive.description":
    "Quand ce n’est plus une ligne de travail que quelqu’un devrait lancer.",
  "archive.consequence":
    "Il n’est plus proposé et ses horaires et règles de démarrage cessent de se déclencher. Les exécutions déjà faites, et ce qu’elles ont produit, restent. Si le pod demande une validation, l’archivage est proposé et attend dans Demandes.",
  "archive.proposed": "L’archivage a été proposé pour validation.",
  "archive.failed": "Impossible d’archiver le processus",
  "ids.process": "Identifiant du processus",
  "ids.space": "Identifiant de l’espace",
  loading: "Chargement du processus…",
};

export const CATALOGS = { en, fr };

/**
 * Pod health's words (`/health`) as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French ("vous"), awaiting the
 * founder's review. A disk's or a service's machine name is a token, worded
 * here when known and humanized otherwise.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  title: "Pod health",
  description:
    "Memory, disks and the database against their alert thresholds, and what frees room.",
  "read.failed": "Couldn’t read this pod’s health.",
  "read.unreadable": "The pod sent an answer this page can’t read.",
  updated: "Checked {when}",

  "state.ok": "All good",
  "state.okNoHost":
    "The database is fine. This pod’s host doesn’t report memory or disks yet.",
  "state.memory.warning": "Memory is running high since {time}",
  "state.memory.critical": "Memory is nearly full since {time}",
  "state.swap.warning": "The host is swapping since {time}",
  "state.swap.critical": "The host is swapping heavily since {time}",
  "state.memoryPressure.warning": "Memory pressure is high since {time}",
  "state.memoryPressure.critical":
    "The pod is stalling for lack of memory since {time}",
  "state.disk.warning": "{disk} is filling up since {time}",
  "state.disk.critical": "{disk} is nearly full since {time}",
  "state.postgresConnections.warning":
    "Database connections are running out since {time}",
  "state.postgresConnections.critical":
    "The database is nearly out of connections since {time}",
  "state.readings.stale": "The host stopped reporting its readings at {time}",
  "state.readings.unreadable": "The host’s readings can’t be read",
  "state.other.warning": "A resource is running high since {time}",
  "state.other.critical": "A resource is nearly exhausted since {time}",
  "state.more": "{n, plural, one {and # more alert} other {and # more alerts}}",

  "section.readings": "Readings",
  "section.readings.hint": "What the host and the database report now",
  "section.actions": "What frees room",
  "section.actions.hint": "Each one can be undone, or comes back by itself",
  "section.thresholds": "Thresholds",

  "reading.readings": "Host readings",
  "reading.memory": "Memory",
  "reading.swap": "Swap",
  "reading.memoryPressure": "Memory pressure",
  "reading.disk": "{disk}",
  "reading.postgresConnections": "Database connections",
  "reading.cpuPressure": "CPU pressure",
  "reading.ioPressure": "Disk wait",
  "reading.load": "Load",
  "reading.databaseSize": "Database size",
  "reading.eventLoop": "Request delay",
  "reading.backup": "Last backup",

  "disk.data": "The data disk",
  "disk.docker": "The Docker disk",
  "disk.other": "The {label} disk",

  "mark.ok": "OK",
  "mark.warning": "Warning",
  "mark.critical": "Critical",
  "mark.unavailable": "Not measured",

  "value.percent": "{n}%",
  "unit.percent": "%",
  "row.valueDetail": "{value} · {detail}",
  "value.perCore": "{n} per core",

  "detail.memory": "{available} available of {total}",
  "detail.swap": "{total} in all",
  "detail.disk": "{free} free of {total}",
  "detail.postgres": "{used} of {max} connections",
  "detail.memoryPressure": "Time the pod waited on memory, last minute",
  "detail.cpuPressure": "Time work waited for the processor, last minute",
  "detail.ioPressure": "Time work waited for the disk, last minute",
  "detail.load": "{cores, plural, one {# core} other {# cores}}",
  "detail.eventLoop": "Slowest 1% of the server’s turns",
  "detail.backup.ok": "Backed up {when}",
  "detail.backup.stale": "Last backup {when}, older than a day",
  "detail.backup.failed": "The last backup failed",
  "detail.backup.never": "No backup yet",
  "detail.readings.fresh": "Last reading {when}",
  "detail.readings.stale": "Last reading {when}",
  "detail.readings.unreadable": "The readings file can’t be read",
  "detail.readings.absent": "This pod’s host doesn’t report its readings yet",

  "action.pause.title": "Pause what is running",
  "action.pause.body":
    "Pausing an automation, a worker or an agent frees memory and connections at once. Resume it the same way.",
  "action.pause.runs": "Open runs",
  "action.pause.rules": "Open automations",
  "action.pause.agents": "Open agents",
  "action.buildCache.title": "Trim the build cache",
  "action.buildCache.body":
    "Frees about {bytes}. Docker keeps 2 GB and rebuilds the rest when it needs it.",
  "action.buildCache.bodyUnknown":
    "Docker keeps 2 GB and rebuilds the rest when it needs it.",
  "action.buildCache.run": "Trim",
  "action.images.title": "Remove old release images",
  "action.images.body":
    "Frees about {bytes}. Keeps the current and the previous release, so you can still roll back.",
  "action.images.bodyUnknown":
    "Keeps the current and the previous release, so you can still roll back.",
  "action.images.run": "Remove old images",
  "action.restart.title": "Restart a service",
  "action.restart.body":
    "Frees the memory a service holds. It is away for a few seconds and nothing stored is lost. The database is never restarted from here.",
  "action.restart.select": "Service",
  "action.restart.run": "Restart…",
  "action.readings.title": "Readings stopped",
  "action.readings.body":
    "The host writes its readings every 2 minutes, with its heal timer. On the machine that hosts the pod, run this:",

  "confirm.restart.title": "Restart {service}?",
  "confirm.restart.body":
    "{service} stops and starts again. It is away for a few seconds; nothing stored is lost.",
  "confirm.restart.confirm": "Restart {service}",

  "result.pending": "Waiting for the host to take it",
  "result.done": "Done {when}",
  "result.doneFreed": "Done {when}, freed {bytes}",
  "result.refused": "The host refused it {when}",
  "result.failed": "It failed {when}",
  "result.unreadable": "The host’s last answer can’t be read",

  "error.title": "Couldn’t ask the host",
  "error.busy": "Another request is still waiting for the host.",
  "error.unavailable": "This pod can’t send requests to its host yet.",
  "error.generic": "The request wasn’t sent. Try again.",

  "thresholds.show": "Change thresholds",
  "thresholds.hide": "Hide thresholds",
  "thresholds.hint":
    "An alert needs 3 readings in a row (about 5 minutes) and clears 5 points below its line.",
  "thresholds.disks": "Disks",
  "thresholds.warn": "Warn at",
  "thresholds.critical": "Critical at",
  "thresholds.diskNote":
    "A disk with under 5 GB free is critical, whatever its percentage.",
  "thresholds.save": "Save thresholds",
  "thresholds.saved": "Thresholds saved",
  "thresholds.failed": "The thresholds weren’t saved. Try again.",
  "problem.not_a_number": "Enter a number.",
  "problem.out_of_range": "Use a number from 1 to 100.",
  "problem.warn_not_below_critical": "Warn must be below critical.",

  "service.backend": "API",
  "service.realtime": "Realtime",
  "service.pod-admin": "Pod admin",
  "service.typesense": "Search",
  "service.browserless": "Web reader",
  "service.rsshub": "Feeds",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Santé du pod",
  description:
    "La mémoire, les disques et la base de données face à leurs seuils d’alerte, et ce qui libère de la place.",
  "read.failed": "Impossible de lire la santé de ce pod.",
  "read.unreadable":
    "Le pod a envoyé une réponse que cette page ne sait pas lire.",
  updated: "Vérifié {when}",

  "state.ok": "Tout va bien",
  "state.okNoHost":
    "La base de données va bien. L’hôte de ce pod ne transmet pas encore la mémoire ni les disques.",
  "state.memory.warning": "La mémoire est élevée depuis {time}",
  "state.memory.critical": "La mémoire est presque pleine depuis {time}",
  "state.swap.warning": "L’hôte utilise le swap depuis {time}",
  "state.swap.critical": "L’hôte utilise fortement le swap depuis {time}",
  "state.memoryPressure.warning":
    "La pression mémoire est élevée depuis {time}",
  "state.memoryPressure.critical":
    "Le pod est ralenti faute de mémoire depuis {time}",
  "state.disk.warning": "{disk} se remplit depuis {time}",
  "state.disk.critical": "{disk} est presque plein depuis {time}",
  "state.postgresConnections.warning":
    "Les connexions à la base de données s’épuisent depuis {time}",
  "state.postgresConnections.critical":
    "La base de données n’a presque plus de connexions depuis {time}",
  "state.readings.stale": "L’hôte a cessé d’envoyer ses mesures à {time}",
  "state.readings.unreadable": "Les mesures de l’hôte sont illisibles",
  "state.other.warning": "Une ressource est élevée depuis {time}",
  "state.other.critical": "Une ressource est presque épuisée depuis {time}",
  "state.more":
    "{n, plural, one {et # autre alerte} other {et # autres alertes}}",

  "section.readings": "Mesures",
  "section.readings.hint":
    "Ce que l’hôte et la base de données indiquent maintenant",
  "section.actions": "Ce qui libère de la place",
  "section.actions.hint":
    "Chaque action peut être annulée, ou se rétablit d’elle-même",
  "section.thresholds": "Seuils",

  "reading.readings": "Mesures de l’hôte",
  "reading.memory": "Mémoire",
  "reading.swap": "Swap",
  "reading.memoryPressure": "Pression mémoire",
  "reading.disk": "{disk}",
  "reading.postgresConnections": "Connexions à la base de données",
  "reading.cpuPressure": "Pression processeur",
  "reading.ioPressure": "Attente disque",
  "reading.load": "Charge",
  "reading.databaseSize": "Taille de la base de données",
  "reading.eventLoop": "Délai des requêtes",
  "reading.backup": "Dernière sauvegarde",

  "disk.data": "Le disque des données",
  "disk.docker": "Le disque Docker",
  "disk.other": "Le disque {label}",

  "mark.ok": "OK",
  "mark.warning": "Attention",
  "mark.critical": "Critique",
  "mark.unavailable": "Non mesuré",

  "value.percent": "{n}\u00a0%",
  "unit.percent": "%",
  "row.valueDetail": "{value} · {detail}",
  "value.perCore": "{n} par cœur",

  "detail.memory": "{available} disponibles sur {total}",
  "detail.swap": "{total} au total",
  "detail.disk": "{free} libres sur {total}",
  "detail.postgres": "{used} connexions sur {max}",
  "detail.memoryPressure":
    "Temps d’attente du pod sur la mémoire, dernière minute",
  "detail.cpuPressure": "Temps d’attente du processeur, dernière minute",
  "detail.ioPressure": "Temps d’attente du disque, dernière minute",
  "detail.load": "{cores, plural, one {# cœur} other {# cœurs}}",
  "detail.eventLoop": "Le 1\u00a0% des tours les plus lents du serveur",
  "detail.backup.ok": "Sauvegardé {when}",
  "detail.backup.stale": "Dernière sauvegarde {when}, il y a plus d’un jour",
  "detail.backup.failed": "La dernière sauvegarde a échoué",
  "detail.backup.never": "Aucune sauvegarde pour l’instant",
  "detail.readings.fresh": "Dernière mesure {when}",
  "detail.readings.stale": "Dernière mesure {when}",
  "detail.readings.unreadable": "Le fichier des mesures est illisible",
  "detail.readings.absent":
    "L’hôte de ce pod ne transmet pas encore ses mesures",

  "action.pause.title": "Mettre en pause ce qui tourne",
  "action.pause.body":
    "Mettre en pause une automatisation, un worker ou un agent libère aussitôt mémoire et connexions. Vous la reprenez de la même façon.",
  "action.pause.runs": "Ouvrir les exécutions",
  "action.pause.rules": "Ouvrir les automatisations",
  "action.pause.agents": "Ouvrir les agents",
  "action.buildCache.title": "Réduire le cache de build",
  "action.buildCache.body":
    "Libère environ {bytes}. Docker en garde 2 Go et reconstruit le reste quand il en a besoin.",
  "action.buildCache.bodyUnknown":
    "Docker en garde 2 Go et reconstruit le reste quand il en a besoin.",
  "action.buildCache.run": "Réduire",
  "action.images.title": "Supprimer les anciennes images de version",
  "action.images.body":
    "Libère environ {bytes}. Garde la version actuelle et la précédente : vous pouvez toujours revenir en arrière.",
  "action.images.bodyUnknown":
    "Garde la version actuelle et la précédente : vous pouvez toujours revenir en arrière.",
  "action.images.run": "Supprimer les anciennes images",
  "action.restart.title": "Redémarrer un service",
  "action.restart.body":
    "Libère la mémoire qu’un service occupe. Il est absent quelques secondes et rien de ce qui est stocké n’est perdu. La base de données n’est jamais redémarrée d’ici.",
  "action.restart.select": "Service",
  "action.restart.run": "Redémarrer…",
  "action.readings.title": "Mesures interrompues",
  "action.readings.body":
    "L’hôte écrit ses mesures toutes les 2 minutes, avec son minuteur de réparation. Sur la machine qui héberge le pod, lancez :",

  "confirm.restart.title": "Redémarrer {service} ?",
  "confirm.restart.body":
    "{service} s’arrête et redémarre. Il est absent quelques secondes ; rien de ce qui est stocké n’est perdu.",
  "confirm.restart.confirm": "Redémarrer {service}",

  "result.pending": "En attente de l’hôte",
  "result.done": "Fait {when}",
  "result.doneFreed": "Fait {when}, {bytes} libérés",
  "result.refused": "L’hôte l’a refusé {when}",
  "result.failed": "Échec {when}",
  "result.unreadable": "La dernière réponse de l’hôte est illisible",

  "error.title": "Impossible de demander à l’hôte",
  "error.busy": "Une autre demande attend encore l’hôte.",
  "error.unavailable":
    "Ce pod ne peut pas encore envoyer de demandes à son hôte.",
  "error.generic": "La demande n’a pas été envoyée. Réessayez.",

  "thresholds.show": "Modifier les seuils",
  "thresholds.hide": "Masquer les seuils",
  "thresholds.hint":
    "Une alerte demande 3 mesures de suite (environ 5 minutes) et se lève 5 points sous son seuil.",
  "thresholds.disks": "Disques",
  "thresholds.warn": "Alerte à",
  "thresholds.critical": "Critique à",
  "thresholds.diskNote":
    "Un disque avec moins de 5 Go libres est critique, quel que soit son pourcentage.",
  "thresholds.save": "Enregistrer les seuils",
  "thresholds.saved": "Seuils enregistrés",
  "thresholds.failed": "Les seuils n’ont pas été enregistrés. Réessayez.",
  "problem.not_a_number": "Saisissez un nombre.",
  "problem.out_of_range": "Utilisez un nombre de 1 à 100.",
  "problem.warn_not_below_critical":
    "L’alerte doit être inférieure au seuil critique.",

  "service.backend": "API",
  "service.realtime": "Temps réel",
  "service.pod-admin": "Administration du pod",
  "service.typesense": "Recherche",
  "service.browserless": "Lecteur web",
  "service.rsshub": "Flux",
};

export const HEALTH_CATALOGS = { en, fr };

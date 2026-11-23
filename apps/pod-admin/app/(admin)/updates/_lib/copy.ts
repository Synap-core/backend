/**
 * Pod updates page words (`/updates`), as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French ("vous"), awaiting the
 * founder's review. "Install" / "Installed", "Update" and "Undo" are the
 * vocabulary's (`resolveActionLabel`), not here; the channel names and the
 * last update's sentences are `updates-model.ts`'s (shared with Home).
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "page.description": "Which version your pod runs and how it updates.",

  "release.title": "Release",
  "release.hint": "What this pod runs, and the last update",
  "release.current": "Current release",
  "release.notRecorded": "Not recorded",
  "release.last": "Last update",
  "release.why": "Why: {reason}",
  "release.unreadable": "The record of the last update couldn’t be read.",
  "release.none": "No update has run on this pod yet.",
  "release.older":
    "This pod manages updates in a newer version. Update it once from the machine hosting it, then come back.",
  "release.failed": "Couldn’t read this pod’s update status.",

  "auto.title": "Auto-update",
  "auto.hint": "Whether the pod installs new releases by itself",
  "auto.switch": "Install updates automatically",
  "auto.on": "New releases on your channel are installed as they come.",
  "auto.off": "Nothing is installed until you update by hand.",
  "auto.channel": "Channel",
  "auto.adminOnly": "Only a pod admin can change these.",
  "auto.save.failed": "Couldn’t save",
  "auto.save.forbidden": "Only a pod admin can change this.",
  "auto.save.retry": "The setting wasn’t changed. Try again.",

  "now.title": "How to update now",
  "now.hint": "Run this on the machine that hosts your pod",
  "now.body":
    "This console can’t run commands on the host, so updating by hand happens in a terminal there.",

  "renderers.title": "Renderers",
  "renderers.hint": "What draws your pod’s cards and boards in this console",
  "renderers.name": "Synap’s renderers",
  "renderers.version": "Version {version}",
  "renderers.version.justInstalled": "Version {version}, installed just now",
  "renderers.none": "Plain cards until installed",
  "renderers.other": "{slug} {version}",
  "renderers.other.why":
    "Other renderers are installed. A pod holds one set at a time, so Synap’s can’t be added beside them.",
  "renderers.state.none": "Not installed",
  "renderers.state.other": "Other renderers",
  "renderers.state.available": "Update available",
  "renderers.state.needsPod": "Needs a newer pod",
  "renderers.state.paused": "Updates paused",
  "renderers.action.reinstall": "Reinstall latest",
  "renderers.action.pause": "Pause updates",
  "renderers.action.resume": "Resume updates",
  "renderers.action.updatePod": "Update the pod first",
  "renderers.action.more": "More renderer actions",
  "renderers.action.undo.label": "Undo the update to {version}",
  "renderers.read.failed": "Couldn’t read which renderers this pod has.",
  "renderers.updates.failed": "Couldn’t check for renderer updates.",
  "renderers.proposed":
    "Request sent for review. It applies once someone with access approves it.",
  "renderers.proposed.open": "Open the request",

  "renderers.refused.byPass": "This pod tried on its own {when}.",
  "renderers.refused.plan_required":
    "Couldn’t install: needs a Synap plan that covers this pod.",
  "renderers.refused.pod_not_enrolled":
    "Couldn’t install: this pod isn’t enrolled with Synap yet. Run this on the machine that hosts it, then try again.",
  "renderers.refused.no_control_plane":
    "Couldn’t install: this pod isn’t connected to Synap.",
  "renderers.refused.insecure_control_plane":
    "Couldn’t install: this pod reaches Synap over an insecure address. The details say what to change.",
  "renderers.refused.pod_not_live":
    "Couldn’t install: Synap doesn’t see this pod running yet (suspended or still being set up). Try again once it is.",
  "renderers.refused.other_renderers":
    "Couldn’t install: other renderers are installed, and a pod holds one set at a time.",
  "renderers.refused.needs_newer_pod":
    "Couldn’t install: Synap’s current renderers need a newer version of this pod. Update the pod, then try again.",
  "renderers.refused.failed":
    "Couldn’t install Synap’s renderers. Nothing changed. Try again in a moment.",

  "renderers.update.available": "Version {version} is available",
  "renderers.update.soak": "It applies on its own {when}.",
  "renderers.update.soakShortly": "It applies on its own shortly.",
  "renderers.update.autoOff":
    "Automatic updates are off on this pod: apply it when you’re ready.",
  "renderers.update.autoOff.door": "Auto-update",
  "renderers.update.settingUnreadable":
    "This pod’s update setting couldn’t be read, so it doesn’t apply on its own.",
  "renderers.update.paused": "You paused updates: apply it when you’re ready.",
  "renderers.update.requires":
    "It needs a newer version of this pod. Update the pod, and it applies.",
  "renderers.update.kit":
    "It waits for you: it drops kit parts another cell on this pod may use.",
  "renderers.update.undone":
    "You went back from it, so it doesn’t apply on its own.",
  "renderers.update.failed": "It didn’t apply on its own. Update to try again.",
  "renderers.update.frozen":
    "Synap’s catalog is paused, so it waits until it resumes.",
  "renderers.update.noOwner":
    "It applies on its own once this pod has an owner.",
  "renderers.update.conflict":
    "A newer version arrived meanwhile. The card now shows it.",
  "renderers.update.failedNow": "Couldn’t apply the update. Nothing changed.",
  "renderers.updated.auto": "Updated on its own to {version} {when}.",
  "renderers.updated.person": "Updated to {version} {when}.",
  "renderers.undone": "Back to the previous version.",
  "renderers.undo.conflict":
    "The renderers changed again since that update. Nothing was undone.",
  "renderers.undo.expired":
    "Undo is available for 30 days, and this update is older. Nothing was undone.",
  "renderers.undo.failed": "Couldn’t undo the update. Nothing changed.",
  "renderers.pause.failed": "Couldn’t change updates. Nothing changed.",
} as const;

export const fr: Catalog<typeof en> = {
  "page.description":
    "La version que fait tourner votre pod, et comment il se met à jour.",

  "release.title": "Version",
  "release.hint": "Ce que fait tourner ce pod, et la dernière mise à jour",
  "release.current": "Version actuelle",
  "release.notRecorded": "Non enregistrée",
  "release.last": "Dernière mise à jour",
  "release.why": "Pourquoi : {reason}",
  "release.unreadable":
    "Impossible de lire l’enregistrement de la dernière mise à jour.",
  "release.none": "Aucune mise à jour n’a encore eu lieu sur ce pod.",
  "release.older":
    "Ce pod gère ses mises à jour dans une version plus récente. Mettez-le à jour une fois depuis la machine qui l’héberge, puis revenez.",
  "release.failed": "Impossible de lire l’état des mises à jour de ce pod.",

  "auto.title": "Mise à jour automatique",
  "auto.hint": "Si le pod installe lui-même les nouvelles versions",
  "auto.switch": "Installer les mises à jour automatiquement",
  "auto.on":
    "Les nouvelles versions de votre canal sont installées dès qu’elles sortent.",
  "auto.off":
    "Rien n’est installé tant que vous ne mettez pas à jour vous-même.",
  "auto.channel": "Canal",
  "auto.adminOnly": "Seul un administrateur du pod peut les modifier.",
  "auto.save.failed": "Enregistrement impossible",
  "auto.save.forbidden": "Seul un administrateur du pod peut modifier ceci.",
  "auto.save.retry": "Le réglage n’a pas changé. Réessayez.",

  "now.title": "Mettre à jour maintenant",
  "now.hint": "À lancer sur la machine qui héberge votre pod",
  "now.body":
    "Cette console ne peut pas lancer de commandes sur la machine hôte : la mise à jour à la main se fait dans un terminal sur celle-ci.",

  "renderers.title": "Affichages",
  "renderers.hint":
    "Ce qui dessine les fiches et les tableaux de votre pod dans cette console",
  "renderers.name": "Affichages de Synap",
  "renderers.version": "Version {version}",
  "renderers.version.justInstalled": "Version {version}, installée à l’instant",
  "renderers.none": "De simples fiches tant qu’ils ne sont pas installés",
  "renderers.other": "{slug} {version}",
  "renderers.other.why":
    "D’autres affichages sont installés. Un pod n’en accueille qu’un ensemble à la fois : ceux de Synap ne peuvent pas s’y ajouter.",
  "renderers.state.none": "Non installé",
  "renderers.state.other": "Autres affichages",
  "renderers.state.available": "Mise à jour disponible",
  "renderers.state.needsPod": "Demande un pod plus récent",
  "renderers.state.paused": "Mises à jour en pause",
  "renderers.action.reinstall": "Réinstaller la dernière version",
  "renderers.action.pause": "Mettre les mises à jour en pause",
  "renderers.action.resume": "Reprendre les mises à jour",
  "renderers.action.updatePod": "Mettre d’abord le pod à jour",
  "renderers.action.more": "Autres actions sur les affichages",
  "renderers.action.undo.label": "Annuler la mise à jour vers {version}",
  "renderers.read.failed":
    "Impossible de lire les affichages installés sur ce pod.",
  "renderers.updates.failed":
    "Impossible de vérifier les mises à jour des affichages.",
  "renderers.proposed":
    "Demande envoyée pour validation. Elle s’appliquera dès qu’une personne habilitée l’approuvera.",
  "renderers.proposed.open": "Ouvrir la demande",

  "renderers.refused.byPass": "Ce pod a essayé de lui-même {when}.",
  "renderers.refused.plan_required":
    "Installation impossible : il faut un abonnement Synap qui couvre ce pod.",
  "renderers.refused.pod_not_enrolled":
    "Installation impossible : ce pod n’est pas encore inscrit auprès de Synap. Lancez cette commande sur la machine qui l’héberge, puis réessayez.",
  "renderers.refused.no_control_plane":
    "Installation impossible : ce pod n’est pas relié à Synap.",
  "renderers.refused.insecure_control_plane":
    "Installation impossible : ce pod joint Synap par une adresse non sécurisée. Les détails indiquent quoi changer.",
  "renderers.refused.pod_not_live":
    "Installation impossible : Synap ne voit pas encore ce pod en marche (suspendu ou en cours de création). Réessayez quand il le sera.",
  "renderers.refused.other_renderers":
    "Installation impossible : d’autres affichages sont installés, et un pod n’en accueille qu’un ensemble à la fois.",
  "renderers.refused.needs_newer_pod":
    "Installation impossible : les affichages actuels de Synap demandent une version plus récente de ce pod. Mettez le pod à jour, puis réessayez.",
  "renderers.refused.failed":
    "Impossible d’installer les affichages de Synap. Rien n’a changé. Réessayez dans un instant.",

  "renderers.update.available": "La version {version} est disponible",
  "renderers.update.soak": "Elle s’appliquera d’elle-même {when}.",
  "renderers.update.soakShortly": "Elle s’appliquera d’elle-même sous peu.",
  "renderers.update.autoOff":
    "Les mises à jour automatiques sont désactivées sur ce pod : appliquez-la quand vous voulez.",
  "renderers.update.autoOff.door": "Mise à jour automatique",
  "renderers.update.settingUnreadable":
    "Le réglage de mise à jour de ce pod est illisible : elle ne s’applique donc pas d’elle-même.",
  "renderers.update.paused":
    "Les mises à jour sont en pause : appliquez-la quand vous voulez.",
  "renderers.update.requires":
    "Elle demande une version plus récente de ce pod. Mettez le pod à jour, et elle s’appliquera.",
  "renderers.update.kit":
    "Elle vous attend : elle retire des éléments du kit qu’une autre cellule de ce pod peut utiliser.",
  "renderers.update.undone":
    "Retour à la version précédente : elle ne s’applique donc plus d’elle-même.",
  "renderers.update.failed":
    "Elle ne s’est pas appliquée d’elle-même. Mettez à jour pour réessayer.",
  "renderers.update.frozen":
    "Le catalogue de Synap est en pause : elle attend qu’il reprenne.",
  "renderers.update.noOwner":
    "Elle s’appliquera d’elle-même dès que ce pod aura un propriétaire.",
  "renderers.update.conflict":
    "Une version plus récente est arrivée entre-temps. La carte l’affiche maintenant.",
  "renderers.update.failedNow":
    "Impossible d’appliquer la mise à jour. Rien n’a changé.",
  "renderers.updated.auto": "Mis à jour automatiquement vers {version} {when}.",
  "renderers.updated.person": "Mis à jour vers {version} {when}.",
  "renderers.undone": "Retour à la version précédente.",
  "renderers.undo.conflict":
    "Les affichages ont de nouveau changé depuis cette mise à jour. Rien n’a été annulé.",
  "renderers.undo.expired":
    "L’annulation reste possible 30 jours, et cette mise à jour est plus ancienne. Rien n’a été annulé.",
  "renderers.undo.failed":
    "Impossible d’annuler la mise à jour. Rien n’a changé.",
  "renderers.pause.failed":
    "Impossible de modifier les mises à jour. Rien n’a changé.",
};

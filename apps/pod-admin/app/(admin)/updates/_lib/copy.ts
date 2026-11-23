/**
 * Pod updates' Renderers row words (`/updates`), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French ("vous"), awaiting the founder's review. "Install" / "Installed",
 * "Update" and "Undo" are the vocabulary's (`resolveActionLabel`), not here.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "renderers.title": "Renderers",
  "renderers.hint": "What draws your pod’s cards and boards in this console",
  "renderers.name": "Synap’s renderers",
  "renderers.version": "Version {version}",
  "renderers.version.justInstalled": "Version {version}, installed just now",
  "renderers.none": "Without them, records show as plain identity cards.",
  "renderers.other":
    "{slug} ({version}) is installed instead. A pod holds one set of renderers at a time.",
  "renderers.state.none": "Not installed",
  "renderers.state.other": "Other renderers",
  "renderers.action.reinstall": "Reinstall latest",
  "renderers.read.failed": "Couldn’t read which renderers this pod has.",
  "renderers.proposed":
    "Sent for review. It installs once someone with access approves it.",
  "renderers.proposed.open": "Open the request",

  "renderers.refused.plan_required":
    "Couldn’t install: needs a Synap plan. No live plan covers this pod.",
  "renderers.refused.pod_not_enrolled":
    "Couldn’t install: this pod isn’t enrolled with its control plane yet. Run this on the machine that hosts it, then try again.",
  "renderers.refused.no_control_plane":
    "Couldn’t install: this pod has no Synap control plane to fetch them from.",
  "renderers.refused.insecure_control_plane":
    "Couldn’t install: this pod reaches its control plane over plain http. Set CONTROL_PLANE_URL to an https:// address, then try again.",
  "renderers.refused.pod_not_live":
    "Couldn’t install: the control plane doesn’t see this pod running yet (suspended or still being set up). Try again once it is.",
  "renderers.refused.other_renderers":
    "Couldn’t install: other renderers are installed, and a pod holds one set at a time.",
  "renderers.refused.failed":
    "Couldn’t install Synap’s renderers. Nothing changed. Try again in a moment.",
  "renderers.refused.needs_newer_pod":
    "Couldn’t install: Synap’s current renderers need a newer version of this pod. Update the pod, then try again.",

  "renderers.update.available": "Version {version} is available.",
  "renderers.update.auto": "It applies on its own {when}.",
  "renderers.update.manual":
    "Automatic updates are off on this pod: apply it when you’re ready.",
  "renderers.update.stopped":
    "You stopped updates: apply it when you’re ready.",
  "renderers.update.requires":
    "It waits for you: it needs a newer version of this pod.",
  "renderers.update.undone":
    "You went back from it, so it doesn’t apply on its own.",
  "renderers.update.failed": "Couldn’t apply the update. Nothing changed.",
  "renderers.updated.auto": "Updated on its own to {version} {when}.",
  "renderers.updated.person": "Updated to {version} {when}.",
  "renderers.undone": "Back to the previous version.",
  "renderers.undo.failed": "Couldn’t undo the update. Nothing changed.",
  "renderers.action.stop": "Stop updates",
  "renderers.action.resume": "Resume updates",
  "renderers.stop.failed": "Couldn’t change updates. Nothing changed.",
  "renderers.updates.failed": "Couldn’t check for renderer updates.",
} as const;

export const fr: Catalog<typeof en> = {
  "renderers.title": "Affichages",
  "renderers.hint":
    "Ce qui dessine les fiches et les tableaux de votre pod dans cette console",
  "renderers.name": "Affichages de Synap",
  "renderers.version": "Version {version}",
  "renderers.version.justInstalled": "Version {version}, installée à l’instant",
  "renderers.none":
    "Sans eux, les fiches s’affichent comme de simples cartes d’identité.",
  "renderers.other":
    "{slug} ({version}) est installé à la place. Un pod n’accueille qu’un ensemble d’affichages à la fois.",
  "renderers.state.none": "Non installé",
  "renderers.state.other": "Autres affichages",
  "renderers.action.reinstall": "Réinstaller la dernière version",
  "renderers.read.failed":
    "Impossible de lire les affichages installés sur ce pod.",
  "renderers.proposed":
    "Envoyé pour validation. L’installation se fera dès qu’une personne habilitée l’approuvera.",
  "renderers.proposed.open": "Ouvrir la demande",

  "renderers.refused.plan_required":
    "Installation impossible : il faut un abonnement Synap. Aucun abonnement actif ne couvre ce pod.",
  "renderers.refused.pod_not_enrolled":
    "Installation impossible : ce pod n’est pas encore inscrit auprès de son plan de contrôle. Lancez cette commande sur la machine qui l’héberge, puis réessayez.",
  "renderers.refused.no_control_plane":
    "Installation impossible : ce pod n’a pas de plan de contrôle Synap d’où les récupérer.",
  "renderers.refused.insecure_control_plane":
    "Installation impossible : ce pod joint son plan de contrôle en http simple. Indiquez une adresse https:// dans CONTROL_PLANE_URL, puis réessayez.",
  "renderers.refused.pod_not_live":
    "Installation impossible : le plan de contrôle ne voit pas encore ce pod en marche (suspendu ou en cours de création). Réessayez quand il le sera.",
  "renderers.refused.other_renderers":
    "Installation impossible : d’autres affichages sont installés, et un pod n’en accueille qu’un ensemble à la fois.",
  "renderers.refused.failed":
    "Impossible d’installer les affichages de Synap. Rien n’a changé. Réessayez dans un instant.",
  "renderers.refused.needs_newer_pod":
    "Installation impossible : les affichages actuels de Synap demandent une version plus récente de ce pod. Mettez le pod à jour, puis réessayez.",

  "renderers.update.available": "La version {version} est disponible.",
  "renderers.update.auto": "Elle s’appliquera d’elle-même {when}.",
  "renderers.update.manual":
    "Les mises à jour automatiques sont désactivées sur ce pod : appliquez-la quand vous voulez.",
  "renderers.update.stopped":
    "Vous avez arrêté les mises à jour : appliquez-la quand vous voulez.",
  "renderers.update.requires":
    "Elle vous attend : elle demande une version plus récente de ce pod.",
  "renderers.update.undone":
    "Vous êtes revenu en arrière, elle ne s’applique donc plus d’elle-même.",
  "renderers.update.failed":
    "Impossible d’appliquer la mise à jour. Rien n’a changé.",
  "renderers.updated.auto": "Mis à jour automatiquement vers {version} {when}.",
  "renderers.updated.person": "Mis à jour vers {version} {when}.",
  "renderers.undone": "Retour à la version précédente.",
  "renderers.undo.failed":
    "Impossible d’annuler la mise à jour. Rien n’a changé.",
  "renderers.action.stop": "Arrêter les mises à jour",
  "renderers.action.resume": "Reprendre les mises à jour",
  "renderers.stop.failed":
    "Impossible de modifier les mises à jour. Rien n’a changé.",
  "renderers.updates.failed":
    "Impossible de vérifier les mises à jour des affichages.",
};

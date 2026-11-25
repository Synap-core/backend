/**
 * "Ways to confirm it's you": the words of the count, the phones and
 * computers card, and the nudge (top bar, Home), as catalogs
 * (`@synap-core/types/i18n`). English is the source and the type. DRAFT
 * French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "waysIn.title": "Ways to confirm it’s you",
  "waysIn.hint":
    "An approval that needs you in person asks for one of these. Keep two, so losing one never locks you out.",
  "waysIn.count": "{count} of {of}",
  "waysIn.line.enough": "You can lose one and still confirm it’s you.",
  "waysIn.line.one":
    "Only one. If you lose it, getting back in takes 24 hours.",
  "waysIn.line.none":
    "None yet. Approvals that need you in person are refused until you add one.",
  "waysIn.line.report":
    "Approvals don’t need you in person on this pod yet. Keep two ways in for when they do.",
  "waysIn.failed": "Couldn’t count your ways to confirm it’s you.",
  "waysIn.retry": "Try again",
  "waysIn.summary": "Your ways to confirm it’s you",
  "waysIn.manage": "Manage",

  "devices.title": "Phones and computers",
  "devices.hint":
    "Face ID on Relay and Touch ID in the desktop app. Set one up on the device itself.",
  "devices.none": "None yet",
  "devices.added": "Added {when}",
  "devices.used": "last used {when}",
  "devices.remove": "Remove",
  "devices.remove.title": "Remove {label}?",
  "devices.remove.consequence":
    "It stops confirming it’s you right away. Every device of yours is told.",
  "devices.remove.confirm": "Remove",
  "devices.cancel": "Cancel",
  "devices.removed": "Removed",
  "devices.failed": "Couldn’t load your phones and computers.",
  "devices.retry": "Try again",
  "devices.notRemoved": "Not removed.",
  "devices.twoWays":
    "Not removed: approvals need you in person, and this would leave you fewer than two ways in. Add another way first.",

  "nudge.first-way.title": "Add a way to confirm it’s you",
  "nudge.first-way.line":
    "Approvals that need you in person are refused until you add a passkey, an authenticator app or recovery codes.",
  "nudge.second-way.title": "Add a second way to confirm it’s you",
  "nudge.second-way.line":
    "You have one. If you lose it, getting back in takes 24 hours.",
  "nudge.codes.title": "Save your recovery codes",
  "nudge.codes.line":
    "If you lose your password and Synap Cloud, they are the only way back in without the server.",
  "nudge.this-device.title": "Set up a passkey on this device",
  "nudge.this-device.line": "Then you can approve from here too.",
  "nudge.this-device.action": "Set up",
  "nudge.open": "Open Security",
  "nudge.skip": "Skip for now",
} as const;

export const fr: Catalog<typeof en> = {
  "waysIn.title": "Vos moyens de confirmer que c’est vous",
  "waysIn.hint":
    "Une approbation qui demande votre présence vous demande l’un d’eux. Gardez-en deux : en perdre un ne vous bloque jamais.",
  "waysIn.count": "{count} sur {of}",
  "waysIn.line.enough":
    "Vous pouvez en perdre un et toujours confirmer que c’est vous.",
  "waysIn.line.one": "Un seul. Si vous le perdez, revenir prend 24 heures.",
  "waysIn.line.none":
    "Aucun pour l’instant. Les approbations qui demandent votre présence sont refusées jusqu’à ce que vous en ajoutiez un.",
  "waysIn.line.report":
    "Les approbations ne demandent pas encore votre présence sur ce pod. Gardez-en deux pour le jour où elles le feront.",
  "waysIn.failed":
    "Impossible de compter vos moyens de confirmer que c’est vous.",
  "waysIn.retry": "Réessayer",
  "waysIn.summary": "Vos moyens de confirmer que c’est vous",
  "waysIn.manage": "Gérer",

  "devices.title": "Téléphones et ordinateurs",
  "devices.hint":
    "Face ID sur Relay et Touch ID dans l’app de bureau. Configurez-les sur l’appareil lui-même.",
  "devices.none": "Aucun pour l’instant",
  "devices.added": "Ajouté {when}",
  "devices.used": "dernière utilisation {when}",
  "devices.remove": "Retirer",
  "devices.remove.title": "Retirer {label} ?",
  "devices.remove.consequence":
    "Il cesse aussitôt de confirmer que c’est vous. Chacun de vos appareils en est informé.",
  "devices.remove.confirm": "Retirer",
  "devices.cancel": "Annuler",
  "devices.removed": "Retiré",
  "devices.failed": "Impossible de charger vos téléphones et ordinateurs.",
  "devices.retry": "Réessayer",
  "devices.notRemoved": "Rien n’a été retiré.",
  "devices.twoWays":
    "Rien n’a été retiré : les approbations demandent votre présence, et il vous resterait moins de deux moyens. Ajoutez-en un autre d’abord.",

  "nudge.first-way.title": "Ajoutez un moyen de confirmer que c’est vous",
  "nudge.first-way.line":
    "Les approbations qui demandent votre présence sont refusées jusqu’à ce que vous ajoutiez une clé d’accès, une app d’authentification ou des codes de récupération.",
  "nudge.second-way.title":
    "Ajoutez un deuxième moyen de confirmer que c’est vous",
  "nudge.second-way.line":
    "Vous en avez un. Si vous le perdez, revenir prend 24 heures.",
  "nudge.codes.title": "Enregistrez vos codes de secours",
  "nudge.codes.line":
    "Si vous perdez votre mot de passe et Synap Cloud, ils sont le seul moyen de revenir sans le serveur.",
  "nudge.this-device.title": "Configurez une clé d’accès sur cet appareil",
  "nudge.this-device.line": "Vous pourrez alors approuver d’ici aussi.",
  "nudge.this-device.action": "Configurer",
  "nudge.open": "Ouvrir Sécurité",
  "nudge.skip": "Plus tard",
};

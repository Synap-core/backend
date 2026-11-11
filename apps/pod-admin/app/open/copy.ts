/**
 * The words of `/open`'s cards, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French, awaiting the founder's
 * review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "bounce.noWebPage": "No web page",
  "bounce.inApp": "It has no page on the web yet. Open it in the Synap app.",
  "document.mark.live": "Live",
  "document.live":
    "This document is live in the Synap app: its parts update there. Below is a copy to read.",
  "document.liveEditable":
    "This document is live in the Synap app: its parts update there, and you edit it there. Below is a copy to read.",
  "document.read": "You can read it here.",
  "document.readEditable": "You can read it here. Edit it in the Synap app.",
  "document.copy": "A copy to read",
  "channel.belongsTo": "Belongs to",
  "channel.belongsToLabel": "What this conversation belongs to",
  "view.handoff.title": "This view is worked in the Synap app",
  "view.handoff.body":
    "Pod admin runs the pod and does not draw boards, tables or dashboards. Open it in the app to see it with live data.",
  "view.handoff.bodySnapshot":
    "This is a read-only summary. Moving cards and filtering happen in the app.",
  "view.handoff.cta": "Open view in the app",
  "view.snapshot.title": "By state",
  "view.snapshot.loading": "Loading this pipeline…",
  "view.snapshot.failed": "This pipeline couldn’t be read.",
  "view.snapshot.empty": "Nothing in this pipeline yet.",
  "view.snapshot.untitled": "Untitled",
  "view.snapshot.stuck": "{n} stuck",
  "view.snapshot.windowed": "last {days} days",
  "view.snapshot.more": "+{n} more",
  "view.snapshot.total": "{n} in total",
  "view.snapshot.unclassified": "{n} in no declared state",
  "view.shows.pipeline": "{noun} by state, one column per state.",
  "view.shows.dashboard":
    "A dashboard of {n, plural, one {# widget} other {# widgets}}.",
  "view.shows.dashboardOver":
    "A dashboard of {n, plural, one {# widget} other {# widgets}} over {noun}.",
  "view.shows.layoutOver": "{layout} view of {noun}.",
  "view.shows.layout": "{layout} view.",
  "view.shows.unknown": "A saved view.",
} as const;

export const fr: Catalog<typeof en> = {
  "bounce.noWebPage": "Pas de page web",
  "bounce.inApp":
    "Cet élément n’a pas encore de page sur le web. Ouvrez-le dans l’application Synap.",
  "document.mark.live": "Vivant",
  "document.live":
    "Ce document est vivant dans l’application Synap : ses parties s’y mettent à jour. Ci-dessous, une copie à lire.",
  "document.liveEditable":
    "Ce document est vivant dans l’application Synap : ses parties s’y mettent à jour, et vous le modifiez là-bas. Ci-dessous, une copie à lire.",
  "document.read": "Vous pouvez le lire ici.",
  "document.readEditable":
    "Vous pouvez le lire ici. Modifiez-le dans l’application Synap.",
  "document.copy": "Une copie à lire",
  "channel.belongsTo": "Rattachée à",
  "channel.belongsToLabel": "Ce à quoi cette conversation est rattachée",
  "view.handoff.title": "Cette vue se travaille dans l’application Synap",
  "view.handoff.body":
    "L’administration du pod fait tourner le pod : elle ne dessine ni tableaux, ni tableaux de bord. Ouvrez la vue dans l’application pour la voir avec les données en direct.",
  "view.handoff.bodySnapshot":
    "Ceci est un résumé en lecture seule. Déplacer les cartes et filtrer se fait dans l’application.",
  "view.handoff.cta": "Ouvrir la vue dans l’application",
  "view.snapshot.title": "Par état",
  "view.snapshot.loading": "Chargement de ce pipeline…",
  "view.snapshot.failed": "Ce pipeline n’a pas pu être lu.",
  "view.snapshot.empty": "Rien dans ce pipeline pour l’instant.",
  "view.snapshot.untitled": "Sans titre",
  "view.snapshot.stuck": "{n, plural, one {# bloqué} other {# bloqués}}",
  "view.snapshot.windowed": "{days} derniers jours",
  "view.snapshot.more": "+{n} de plus",
  "view.snapshot.total": "{n} au total",
  "view.snapshot.unclassified": "{n} sans état déclaré",
  "view.shows.pipeline": "{noun} par état, une colonne par état.",
  "view.shows.dashboard":
    "Un tableau de bord de {n, plural, one {# widget} other {# widgets}}.",
  "view.shows.dashboardOver":
    "Un tableau de bord de {n, plural, one {# widget} other {# widgets}} sur {noun}.",
  "view.shows.layoutOver": "Vue {layout} de {noun}.",
  "view.shows.layout": "Vue {layout}.",
  "view.shows.unknown": "Une vue enregistrée.",
};

/** `/open`'s translator, in the ambient catalog locale. */
export function openT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

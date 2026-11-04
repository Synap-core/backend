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
};

/** `/open`'s translator, in the ambient catalog locale. */
export function openT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

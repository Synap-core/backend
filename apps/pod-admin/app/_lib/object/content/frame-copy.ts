/**
 * The words around a stored page's frame (`html-frame`) and a module
 * cell's frame (`module-frame`, `rendered-object`), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French ("vous"), awaiting the founder's review. The reason a page is not
 * run (`frameNetworkCodeRefusal`) is the author's technical sentence: it
 * stays in English, behind `refused.why`, never in the reader's line.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "refused.mark": "Not run",
  "refused.line": "This page can’t run here.",
  "refused.why": "Why",
  "tooLarge.mark": "Too large",
  "tooLarge.line": "This page is {size}. The console runs pages up to {max}.",
  "left.line": "This page tried to open another address, so it was stopped.",
  // A link to another site: the console asks first (`frame-link-door`).
  "link.external.title": "Open a page on {host}?",
  "link.external.body":
    "This page asks to open another site in a new tab. Only this address opens: anything the page added after it is left out.",
  "link.external.open": "Open in a new tab",
  viewSource: "View source",
  "toggle.aria": "Show this page as",
  "toggle.page": "Page",
  "toggle.source": "Source",
  fullSize: "Full size",
  "preview.note": "Preview. It reads nothing from your pod until approved.",
  // What is drawn: a view, a record's card or detail, or any other cell.
  "renderer.loading":
    "{subject, select, view {Drawing this view…} entity {Drawing this record…} other {Drawing…}}",
  "renderer.notInstalled": "Synap’s renderers aren’t on this pod.",
  "renderer.failed":
    "{subject, select, view {Couldn’t draw this view} entity {Couldn’t draw this record} other {Couldn’t draw this}}",
  "renderer.partly": "Showing the default: couldn’t read this kind’s choice.",
  "renderer.needsKit": "This needs parts this pod doesn’t have.",
  "renderer.refused.mark": "Not drawn",
  "renderer.refused.line": "This can’t run here.",
  "renderer.write.proposed": "Sent for review",
  "renderer.write.proposedBody": "The change waits for someone to approve it.",
  "renderer.write.review": "Review",
  "renderer.write.failed": "Couldn’t save this change",
  "renderer.write.failedHint": "Nothing changed. Try again.",
} as const;

export const fr: Catalog<typeof en> = {
  "refused.mark": "Non lancée",
  "refused.line": "Cette page ne peut pas s’exécuter ici.",
  "refused.why": "Pourquoi",
  "tooLarge.mark": "Trop volumineuse",
  "tooLarge.line":
    "Cette page fait {size}. La console exécute les pages jusqu’à {max}.",
  "left.line":
    "Cette page a tenté d’ouvrir une autre adresse : elle a été arrêtée.",
  "link.external.title": "Ouvrir une page de {host} ?",
  "link.external.body":
    "Cette page demande à ouvrir un autre site dans un nouvel onglet. Seule cette adresse s’ouvre : ce que la page y avait ajouté est retiré.",
  "link.external.open": "Ouvrir dans un nouvel onglet",
  viewSource: "Voir la source",
  "toggle.aria": "Afficher cette page en tant que",
  "toggle.page": "Page",
  "toggle.source": "Source",
  fullSize: "Plein écran",
  "preview.note": "Aperçu. Il ne lit rien de votre pod avant l’approbation.",
  "renderer.loading":
    "{subject, select, view {Affichage de cette vue…} entity {Affichage de cette fiche…} other {Affichage…}}",
  "renderer.notInstalled":
    "Les moteurs d’affichage de Synap ne sont pas sur ce pod.",
  "renderer.failed":
    "{subject, select, view {Impossible d’afficher cette vue} entity {Impossible d’afficher cette fiche} other {Impossible d’afficher cet élément}}",
  "renderer.partly":
    "Affichage par défaut : le choix de ce type n’a pas pu être lu.",
  "renderer.needsKit":
    "Cet élément a besoin de parties que ce pod ne possède pas.",
  "renderer.refused.mark": "Non affiché",
  "renderer.refused.line": "Cet élément ne peut pas s’exécuter ici.",
  "renderer.write.proposed": "Envoyé pour validation",
  "renderer.write.proposedBody":
    "La modification attend que quelqu’un l’approuve.",
  "renderer.write.review": "Examiner",
  "renderer.write.failed": "Impossible d’enregistrer cette modification",
  "renderer.write.failedHint": "Rien n’a changé. Réessayez.",
};

/** What a renderer draws, as the words choose (`renderer.loading`, `renderer.failed`). */
export type RendererWordSubject = "view" | "entity" | "cell";

/** The frame's translator, in the ambient catalog locale. */
export function frameT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

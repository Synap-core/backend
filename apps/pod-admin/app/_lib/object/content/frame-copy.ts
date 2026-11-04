/**
 * The words around a stored page's frame (`html-frame`), as catalogs
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
  "tooLarge.line":
    "This page is {size}. The console runs pages up to {max}.",
  "left.line": "This page tried to open another address, so it was stopped.",
  "viewSource": "View source",
  "toggle.aria": "Show this page as",
  "toggle.page": "Page",
  "toggle.source": "Source",
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
  "viewSource": "Voir la source",
  "toggle.aria": "Afficher cette page en tant que",
  "toggle.page": "Page",
  "toggle.source": "Source",
};

/** The frame's translator, in the ambient catalog locale. */
export function frameT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

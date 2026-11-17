/**
 * The words around a `:::synap-ask` card (`embed-ask`): the catalog is shared
 * (`@synap-core/types/ask`, `askEmbedCopy`); this file only picks the locale.
 */
import { askEmbedCopy } from "@synap-core/types/ask";
import { ambientCatalogLocale, createT } from "@synap-core/types/i18n";

/** The card's translator, in the ambient catalog locale. */
export function askEmbedT() {
  return createT(ambientCatalogLocale(), askEmbedCopy);
}

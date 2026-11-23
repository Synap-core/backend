/**
 * Words of the console's media door, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French, awaiting the founder's
 * review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  loading: "Loading {name}…",
  retry: "Try again",
  download: "Download",
  image: "Image: {name}",
  open: "Open {name} full size",
} as const;

export const fr: Catalog<typeof en> = {
  loading: "Chargement de {name}…",
  retry: "Réessayer",
  download: "Télécharger",
  image: "Image : {name}",
  open: "Ouvrir {name} en taille réelle",
};

/** The media door's translator, in the ambient catalog locale. */
export function mediaT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

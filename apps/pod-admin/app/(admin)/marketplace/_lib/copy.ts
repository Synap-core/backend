/**
 * The marketplace catalog tab's words, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French ("vous"), awaiting the
 * founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "search.aria": "Search the catalog",
  "search.placeholder": "Search the catalog…",
  "filter.source": "Source",
  "filter.kind": "Kind",
  failed: "The pod couldn't read its catalog.",
  "noSource.body": "No catalog source is on, so there is nothing to browse.",
  "noSource.link": "See the sources",
  "empty.filtered": "Nothing in the catalog matches this filter.",
  "empty.catalog": "The catalog is empty.",
  showing: "Showing {shown} of {total}. Narrow the search to see the rest.",
  from: "· from {source}",
  loading: "Loading the catalog",
} as const;

export const fr: Catalog<typeof en> = {
  "search.aria": "Rechercher dans le catalogue",
  "search.placeholder": "Rechercher dans le catalogue…",
  "filter.source": "Source",
  "filter.kind": "Type",
  failed: "Le pod n’a pas pu lire son catalogue.",
  "noSource.body":
    "Aucune source de catalogue n’est active : il n’y a rien à parcourir.",
  "noSource.link": "Voir les sources",
  "empty.filtered": "Rien dans le catalogue ne correspond à ce filtre.",
  "empty.catalog": "Le catalogue est vide.",
  showing:
    "{shown} affichés sur {total}. Affinez la recherche pour voir le reste.",
  from: "· depuis {source}",
  loading: "Chargement du catalogue",
};

/** The catalog tab's translator, in the ambient catalog locale. */
export function marketplaceT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

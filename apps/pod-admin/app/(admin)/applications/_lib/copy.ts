/**
 * The applications page's words, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French ("vous"), awaiting the
 * founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  connect: "Connect an app",
  "filter.label": "How it connects",
  "filter.all": "All apps",
  waiting:
    "{n, plural, one {# app request waiting} other {# app requests waiting}}",
} as const;

export const fr: Catalog<typeof en> = {
  connect: "Connecter une app",
  "filter.label": "Comment elle se connecte",
  "filter.all": "Toutes les apps",
  waiting:
    "{n, plural, one {# demande d’app en attente} other {# demandes d’app en attente}}",
};

/** The applications page's translator, in the ambient catalog locale. */
export function applicationsT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

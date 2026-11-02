/**
 * The words of the goal model's rows, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type, French translates it ("vous"). Read by
 * the row model (`goalCriterionRows`), so the desk's CriterionRow and relay's
 * twin draw the same words and neither keeps a local catalog. A `{title}`
 * param is a session's title: content, shown as written, never translated.
 * DRAFT French, awaiting the founder's review with the vocabulary's.
 *
 * Not the vocabulary: "Nobody on it" is a sentence about a criterion, not the
 * name of a stored value. The wait kind `nobody` ("Nobody",
 * `WAIT_KIND_LABELS`) names who a goal waits on, a different thing.
 */
import { ambientCatalogLocale } from "../i18n/ambient.js";
import { createT, type Catalog, type Locale } from "../i18n/index.js";

export const en = {
  /** Who works a criterion (`servedBy`), read and empty: no open session serves it. */
  "goal.criterion.servedBy.nobody": "Nobody on it",
  /** Who works a criterion, more than one session: the first one's title and how many more. */
  "goal.criterion.servedBy.more": "{title} +{more}",
} as const;

export const fr: Catalog<typeof en> = {
  "goal.criterion.servedBy.nobody": "Personne dessus",
  "goal.criterion.servedBy.more": "{title} +{more}",
};

/** The goal model's catalogs, for a surface that composes its own translator. */
export const goalCopy = { en, fr } as const;

/** The goal model's translator, in `locale` (else the ambient catalog locale). */
export function goalT(locale?: Locale) {
  return createT(locale ?? ambientCatalogLocale(), goalCopy);
}

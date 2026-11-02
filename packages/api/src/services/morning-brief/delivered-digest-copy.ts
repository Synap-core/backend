/**
 * The delivered digest's counts, as catalogs (`@synap-core/types/i18n`): a
 * count is a plural message, never `n === 1 ? one : many` by hand (review
 * 459d5e5b, "the digest's hand-written plurals"). English is the source and
 * the type; French translates it (DRAFT, like the vocabulary's French,
 * awaiting the founder's review). The session noun comes from the vocabulary
 * door (`resolveObjectNoun("session")`), so it is passed in, never written
 * here. English output is byte-identical to the hand-written text it replaced.
 */
import {
  createT,
  DEFAULT_LOCALE,
  type Catalog,
  type Locale,
} from "@synap-core/types/i18n";

export const en = {
  "digest.prsMerged":
    "{n, plural, one {# pull request} other {# pull requests}}{plus} merged",
  "digest.commitsLanded":
    "{n, plural, one {# commit} other {# commits}}{plus} landed",
  "digest.outcomesMet":
    "{n, plural, one {# outcome} other {# outcomes}}{plus} delivered",
  "digest.sessionsClosed":
    "{n, plural, one {# {noun}} other {# {nouns}}}{plus} closed",
} as const;

export const fr: Catalog<typeof en> = {
  "digest.prsMerged":
    "{n, plural, one {# pull request{plus} fusionnée} many {# de pull requests{plus} fusionnées} other {# pull requests{plus} fusionnées}}",
  "digest.commitsLanded":
    "{n, plural, one {# commit{plus} intégré} many {# de commits{plus} intégrés} other {# commits{plus} intégrés}}",
  "digest.outcomesMet":
    "{n, plural, one {# résultat{plus} livré} many {# de résultats{plus} livrés} other {# résultats{plus} livrés}}",
  "digest.sessionsClosed":
    "{n, plural, one {# {noun}{plus} fermé} many {# de {nouns}{plus} fermés} other {# {nouns}{plus} fermés}}",
};

/** The digest's translator, in `locale` (the recipient's; English when unknown). */
export function deliveredDigestT(locale: Locale = DEFAULT_LOCALE) {
  return createT(locale, { en, fr });
}

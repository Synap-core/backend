/**
 * The timeline's own words, as catalogs (`@synap-core/types/i18n`): only the
 * day heading and the folded-checks line. Every other word of a row comes
 * from the vocabulary door through `entryOf`. DRAFT French ("vous").
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  today: "Today",
  unknownDay: "Date unknown",
  checks: "{n, plural, one {# check passed} other {# checks passed}}",
} as const;

export const fr: Catalog<typeof en> = {
  today: "Aujourd’hui",
  unknownDay: "Date inconnue",
  checks:
    "{n, plural, one {# vérification réussie} other {# vérifications réussies}}",
};

export const CATALOGS = { en, fr };

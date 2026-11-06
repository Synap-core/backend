/**
 * The audit log's words for the "went through without a proof" lens, as
 * catalogs (`@synap-core/types/i18n`): English is the source and the type.
 * DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "lens.all": "Went through without a proof",
  "lens.kind": "Went through without a proof: {kind}",
  "lens.window": "Opens on the last {days} days, the window Security counts.",
  "lens.clear": "Show the whole audit log",
  "lens.empty": "Nothing went through without a proof in these dates.",
} as const;

export const fr: Catalog<typeof en> = {
  "lens.all": "Passé sans preuve de présence",
  "lens.kind": "Passé sans preuve de présence : {kind}",
  "lens.window":
    "S’ouvre sur les {days} derniers jours, la période que compte Sécurité.",
  "lens.clear": "Afficher tout le journal d’audit",
  "lens.empty": "Rien n’est passé sans preuve de présence sur ces dates.",
};

export const CATALOGS = { en, fr };

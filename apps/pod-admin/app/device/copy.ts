/**
 * `/device`'s new words, as catalogs (`@synap-core/types/i18n`): English is
 * the source and the type. The page's older words still sit in its views and
 * move here as they change. DRAFT French ("vous"), awaiting the founder's
 * review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  /** Under the write-mode pick, for a NEW computer (plan 07ecf0be D1b). */
  "writeMode.newComputer":
    "{computer} starts with this too: no agent on it ever does more. You can change it on its page.",
} as const;

export const fr: Catalog<typeof en> = {
  "writeMode.newComputer":
    "{computer} démarre aussi avec ce réglage : aucun agent dessus ne fait jamais plus. Vous pouvez le changer sur sa page.",
};

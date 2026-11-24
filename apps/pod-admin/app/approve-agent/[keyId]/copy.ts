/**
 * `/approve-agent`'s words for the agent inside its computer, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French ("vous"), awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "inComputer.runsAs": "Runs as {seat}.",
  "inComputer.keeps": "Keeps its permission.",
  "inComputer.keepsMode": "Keeps its permission: {mode}.",
  "inComputer.change": "Change…",
} as const;

export const fr: Catalog<typeof en> = {
  "inComputer.runsAs": "Tourne sous {seat}.",
  "inComputer.keeps": "Garde sa permission.",
  "inComputer.keepsMode": "Garde sa permission : {mode}.",
  "inComputer.change": "Changer…",
};

/** The approve-agent translator, in the ambient catalog locale. */
export function approveAgentT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

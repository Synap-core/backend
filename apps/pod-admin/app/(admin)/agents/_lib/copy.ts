/**
 * Agents' header words (a client place, PA-G-06), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. The title
 * is the vocabulary's plural; the roster below keeps its English words for
 * now. DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  description:
    "Every AI that works with you, how it is doing, and who answers for it.",
} as const;

export const fr: Catalog<typeof en> = {
  description:
    "Chaque IA qui travaille avec vous, comment elle se porte, et qui en répond.",
};

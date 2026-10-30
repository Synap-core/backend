/**
 * Équipe's header words (a client place, PA-G-06), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. The lists,
 * drawer and invite form below keep their English words for now. DRAFT
 * French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  title: "Members",
  description:
    "The people who can sign in, what they can do, and the invitations still open.",
  add: "Add people",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Équipe",
  description:
    "Les personnes qui peuvent se connecter, ce qu’elles peuvent faire, et les invitations en cours.",
  add: "Ajouter des personnes",
};

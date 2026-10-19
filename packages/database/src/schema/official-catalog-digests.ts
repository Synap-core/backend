/**
 * Official catalog digests — what the last VERIFIED signed index of Synap's
 * catalog vouches for, one row per listed (kind, slug). Written only by the
 * catalog sync after the index verified (root key → keys statement → index
 * signature), replaced whole on every verified index and never wiped on a
 * failure (the last verified copy stays). Every reader of an official
 * definition checks it here before installing or converging
 * (`services/capabilities/official-catalog-trust.ts` in @synap/api).
 */

import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const officialCatalogDigests = pgTable(
  "official_catalog_digests",
  {
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    version: text("version").notNull(),
    /** sha256 (hex) of the definition's canonical JSON (`canonicalDefinitionJson`). */
    contentHash: text("content_hash").notNull(),
    requiredTier: text("required_tier"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.slug] })]
);

export type OfficialCatalogDigestRow =
  typeof officialCatalogDigests.$inferSelect;
export type NewOfficialCatalogDigestRow =
  typeof officialCatalogDigests.$inferInsert;

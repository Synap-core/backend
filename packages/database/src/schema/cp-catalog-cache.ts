/**
 * CP Catalog Cache — pod-local persisted CACHE of Control-Plane (and future
 * federated) catalog PROVIDERS, across all four marketplace kinds (capability |
 * automation | template | cell).
 *
 * Generalizes `capability-template-cache.ts` (which stays in place, unchanged,
 * until a later cleanup migration cuts reconcile over — see P2.4-B in
 * CAPABILITY-MARKETPLACE-PLAN.md). Same stale-while-revalidate contract: NOT a
 * source of truth, a catalog PROVIDER is (today always the Control Plane via
 * `source` = its base URL); a background sync job (packages/jobs
 * `cp-catalog-sync`) refreshes this table so catalog reads NEVER block on a
 * live fetch. `source` is carried from day one (P2.10.2) so adding a second
 * catalog provider later is a sync-list entry, never a migration or schema
 * change.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const cpCatalogCache = pgTable(
  "cp_catalog_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Catalog provider base URL this row was synced from (today always CONTROL_PLANE_URL). */
    source: text("source").notNull(),
    /** One of "capability" | "automation" | "template" | "cell". */
    kind: text("kind").notNull(),
    /** Stable catalog identity within (source, kind). */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    version: text("version"),
    tier: text("tier"),
    vendor: text("vendor"),
    tags: text("tags").array(),
    contentHash: text("content_hash"),
    /**
     * The full kind-discriminated payload (CapabilityDefinition, package
     * definition, or cell record) needed to install this entry. Typed loosely
     * so this schema package stays dependency-free; consumers cast per `kind`.
     * NULLABLE: the CP's public `GET /api/packages` list route (source for
     * kind=automation|template) omits the definition body by design ("can be
     * large") — only `/marketplace/capabilities` and `/marketplace/cells`
     * return it inline. A null definition here means the full body still
     * requires a per-slug `GET /api/packages/:slug/:version` fetch at install
     * time (Wave 3b's concern, not this cache's).
     */
    definition: jsonb("definition").$type<Record<string, unknown>>(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceKindSlugIdx: uniqueIndex("uniq_cp_catalog_cache_source_kind_slug").on(
      table.source,
      table.kind,
      table.slug
    ),
    kindIdx: index("idx_cp_catalog_cache_kind").on(table.kind),
  })
);

export type CpCatalogCacheRow = typeof cpCatalogCache.$inferSelect;
export type NewCpCatalogCacheRow = typeof cpCatalogCache.$inferInsert;
export const insertCpCatalogCacheSchema = createInsertSchema(cpCatalogCache);
export const selectCpCatalogCacheSchema = createSelectSchema(cpCatalogCache);

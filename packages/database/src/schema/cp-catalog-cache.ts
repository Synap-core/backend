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

/** A third-party listing's facts, copied from its verified `synap-index.json`. */
export interface CatalogListing {
  /** Absolute https URL on the index's own origin. */
  definitionUrl: string;
  /** sha256 (hex) of the definition's exact bytes. */
  sha256: string;
  installUrl?: string | null;
  homepageUrl?: string | null;
  icon?: string | null;
}

export const cpCatalogCache = pgTable(
  "cp_catalog_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * Where this row came from: the official catalog's base URL
     * (CONTROL_PLANE_URL, else Synap's public catalog), or a third-party
     * source's id (`acme` — never contains `://`).
     */
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
    /**
     * Third-party sources only (0327): the signed listing facts for this row —
     * where its definition lives and the sha256 it must match, and the
     * publisher's pages a showcase listing opens. NULL on official rows.
     */
    listing: jsonb("listing").$type<CatalogListing>(),
    /**
     * Tombstone (0322, template kind only): set when the catalog RETIRED this
     * entry. A retired row is KNOWN, not installable — every browse/install
     * reader filters it out (`isNull(retiredAt)`); only template health reads
     * it, so a pod can tell "retired, replaced by X" from "never heard of it".
     * NULL on every row synced from a CP that predates retirement.
     */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    /** Live catalog slug of the same kind that replaces a retired entry. */
    replacedBySlug: text("replaced_by_slug"),
    /** One plain sentence a person reads: why this entry was retired. */
    retiredReason: text("retired_reason"),
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

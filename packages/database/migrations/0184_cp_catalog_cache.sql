-- 0184_cp_catalog_cache.sql
-- CP Catalog Cache (Wave 3a — CAPABILITY-MARKETPLACE-PLAN.md P2.4-B): a
-- pod-local stale-while-revalidate cache of catalog-provider entries across all
-- four marketplace kinds (capability | automation | template | cell). Additive:
-- capability_template_cache (0155) stays in place unchanged; a later cleanup
-- migration cuts reconcile over. `source` (the catalog provider base URL) is
-- carried from day one so a future second provider is a sync-list entry, never
-- a schema change. `definition` is NULLABLE: the CP's public GET /api/packages
-- list route (source for kind=automation|template) omits the definition body
-- by design; only /marketplace/capabilities and /marketplace/cells return it
-- inline. Idempotent per repo migration rules.

CREATE TABLE IF NOT EXISTS "cp_catalog_cache" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "source"       text        NOT NULL,
  "kind"         text        NOT NULL,
  "slug"         text        NOT NULL,
  "name"         text        NOT NULL,
  "description"  text,
  "version"      text,
  "tier"         text,
  "vendor"       text,
  "tags"         text[],
  "content_hash" text,
  "definition"   jsonb,
  "synced_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cp_catalog_cache_source_kind_slug"
  ON "cp_catalog_cache" ("source", "kind", "slug");

CREATE INDEX IF NOT EXISTS "idx_cp_catalog_cache_kind" ON "cp_catalog_cache" ("kind");

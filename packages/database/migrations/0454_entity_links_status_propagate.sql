-- 0454 — entity_links: the typed edges the dynamic status-propagation graph
-- uses (Phase 0 of the status links plan, decision aa0de6e6).
--
-- A single typed edge between two entity rows, with `link_type` selecting the
-- behaviour (only "status-propagates" exists in Phase 0) and `config`
-- carrying the type-specific payload — for status-propagates, `mapping`
-- (source status → target status).

CREATE TABLE IF NOT EXISTS "entity_links" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_entity_id"  uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "target_entity_id"  uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "link_type"         text NOT NULL DEFAULT 'status-propagates',
  "config"            jsonb,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "entity_links_source_target_type_unique"
  ON "entity_links" ("source_entity_id", "target_entity_id", "link_type");

CREATE INDEX IF NOT EXISTS "entity_links_source_idx" ON "entity_links" ("source_entity_id");
CREATE INDEX IF NOT EXISTS "entity_links_target_idx" ON "entity_links" ("target_entity_id");
CREATE INDEX IF NOT EXISTS "entity_links_type_idx"   ON "entity_links" ("link_type");
